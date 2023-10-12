# Change Log

All notable changes to the "wireit" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## Unreleased

- Support the find all references command (default keybinding F12), to find all
  scripts that depend on the script under the cursor. This searches all
  package.json files reachable from all open package.json files, as well as from all package.json files in workspace roots.

## [0.7.0] - 2023-09-12

- More reliably handle and report diagnostics for scripts with invalid
  configurations. Specifically fixed https://github.com/google/wireit/issues/803.

## [0.6.0] - 2023-02-06

- Updated to allow scripts that are in the "wireit" section but not the main
  "scripts" section to be used as dependencies, added in Wireit v0.9.4.

## [0.5.0] - 2022-12-15

- Updated to support the new "env" features of Wireit v0.9.1.

## [0.4.0] - 2022-11-14

- Updated to support the new "service" and "cascade" features of Wireit v0.7.3.

## [0.3.0] - 2022-05-11

- Use the same logic as the CLI for finding diagnostics. This adds many new
  diagnostics, like diagnostics for missing dependencies, or cycles in the
  dependency graph!

- Add jump to definition support to jump right to where a dependency is defined.

- Also added jump to definition for going from the scripts section to a wireit
  configuration object.

## [0.2.0] - 2022-05-04

- Add code actions to fix some common mistakes, as well as to convert a script
  to use wireit.

## [0.1.0] - 2022-04-28

- Applies a hardcoded JSON Schema to package.json files with types and
  documentation for the wireit config format.

- Surfaces diagnostics from both the JSON schema and some static analysis.
