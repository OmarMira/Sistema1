# Isolated Windows production build

Use `node installer/windows/build.cjs --build` on Windows x64. It creates an owned `.checks/build-*` source snapshot, leaves the running development `.next` intact and uses only disposable environment values with an unreachable loopback database during compilation. No `.env`, production account or existing database is imported.

`latest-build.json` names the actual generated payload. Compile it using `build.cjs --compile <payload>`, then run `acceptance.cjs --installer <actual-exe> --browser`. The acceptance command owns new program/data directories, initializes a private native PostgreSQL cluster, deploys the real migration history and tests actual startup/restart/uninstall/data retention. It never substitutes `db push` or a fabricated completion flag.

Build, compiler, installation, browser geometry and live inbox proof are separate outcomes. A source or unit-test pass proves none of the later stages. The browser's code-form receipt is deliberately mocked for geometry only; actual missing-mail behavior is checked through the installed server.
