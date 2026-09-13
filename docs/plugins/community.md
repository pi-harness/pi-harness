# Community plugins

Community plugins are regular npm packages that target `@pi-harness/plugin-api`. A plugin should document its purpose, required permissions, supported Pi Harness versions, configuration keys, and whether it accesses the network, filesystem, or subprocesses.

## Listing a plugin

Open a pull request adding the package to the community catalog. Include the npm package name, repository URL, license, maintainer, latest tested harness version, and a short description. The catalog entry is metadata only; users remain responsible for reviewing and trusting executable plugin code.

## Compatibility

Plugins should declare a peer dependency range for `@pi-harness/plugin-api`. Breaking API changes require a major version. Maintainers should keep one release line compatible with the latest stable Pi Harness release and document migration steps for older lines.

## Review and retirement

Catalog review checks metadata, license, buildability, and obvious unsafe defaults. It does not guarantee that a plugin is secure. A plugin may be marked deprecated when it is unmaintained, incompatible, or superseded; removal should include a migration note.
