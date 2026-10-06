# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A new version
heading merged to main is released: see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#releasing).

## [Unreleased]

### Added

- A marimohub compute adapter that runs notebook kernels as Armada jobs, loaded through
  marimohub's external adapter library mode.
- The kernel agent as static Linux binaries for amd64 and arm64, with a Dockerfile that
  builds the agent image from them, in the npm package.
