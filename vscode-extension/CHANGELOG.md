# Change Log

All notable changes to the "wireit" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
