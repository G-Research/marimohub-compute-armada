// The kernel agent: PID 1 of a kernel container, and marimohub's way in.
//
// Armada has no exec. What it has is the ability to expose a port the pod
// declares and to report that port's address in an event. So the container
// runs this program in place of `sleep infinity`: it keeps the container
// alive, listens on a port, and runs the commands marimohub sends it. The
// adapter reads the port's address from the same event it reads the kernel's
// from, and holds no Kubernetes credential of any kind (AGENT-DESIGN.md).
//
// One request type, POST /exec, is enough for a full session, because every
// adapter operation is a shell command. The response streams: stdout and
// stderr chunks as they are produced, then the exit status. Streaming is what
// makes cancellation work. When the caller goes away, the request context
// ends, and the agent kills the command's process group, which is the thing a
// Kubernetes exec could never do for us.
//
// Requests carry a bearer token. The pod spec holds only its SHA-256, so a
// pod spec read back through Armada's API reveals nothing usable.
package main

import (
	"crypto/subtle"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// TokenHashEnv names the environment variable carrying the hex SHA-256 of the
// bearer token every request must present.
const TokenHashEnv = "MH_AGENT_TOKEN_SHA256"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "install" {
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "usage: agent install <path>")
			os.Exit(2)
		}
		if err := install(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
		return
	}

	port := flag.Int("port", 8718, "port to listen on")
	bind := flag.String("bind", "", "address to bind, all interfaces when empty")
	grace := flag.Duration("grace", 25*time.Second, "how long to wait for children after SIGTERM")
	flag.Parse()

	hash, err := hex.DecodeString(os.Getenv(TokenHashEnv))
	if err != nil || len(hash) != 32 {
		log.Fatalf("%s must be the hex SHA-256 of the bearer token", TokenHashEnv)
	}

	agent := newAgent(hash)
	go reapOrphans(agent.owns)

	server := &http.Server{
		Addr:              net.JoinHostPort(*bind, strconv.Itoa(*port)),
		Handler:           agent.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()
	log.Printf("kernel agent listening on %s as pid %d", server.Addr, os.Getpid())

	// Kubernetes stops the container by sending SIGTERM to PID 1 and waiting
	// the grace period. Forward it, so the kernel gets its chance to flush, and
	// leave once every child is gone or the grace period is spent.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	sig := <-stop
	log.Printf("received %s, stopping children", sig)
	agent.shutdown(*grace)
	os.Exit(0)
}

// install copies this binary to path, for the init container that puts the
// agent into a volume the kernel container mounts. It replaces `cp`, so the
// agent image can be empty apart from the agent itself.
func install(path string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	source, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, source, 0o755); err != nil {
		return err
	}
	// WriteFile honours the umask, and the mode is the whole point.
	return os.Chmod(path, 0o755)
}

// tokenMatches compares the hash of a presented token in constant time.
func tokenMatches(presented []byte, hash []byte) bool {
	return subtle.ConstantTimeCompare(presented, hash) == 1
}
