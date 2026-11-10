Runtime redistributable: PostgreSQL Windows binaries
Source reference: https://www.postgresql.org/download/windows/ -> EDB binary page https://www.enterprisedb.com/download-postgresql-binaries (official PostgreSQL listing). Binary page lists Windows x86-64 zip archives by installer version; retrieval selects the Windows x64 archive from the same page, version-independent at retrieval time.
Pinning method: the MANIFEST.md records hash/license for the specific retrieved file; if a newer version replaces the binary, retrieve the new file and update MANIFEST.md.
No installation performed; only retrieval into this .cache directory.
No global install, DB/service/registry changes, credentials, accounts, or remote deployment.
Pin method: retrieve any Windows x64 binary archive listed at the EDB page; record file/hash/license; replace if new version released. Not hardcoded to 16.15 URL.
