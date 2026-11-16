#!/usr/bin/env python3
"""Export a stopped ID Ledger snapshot or compare it with a restored D1 export."""

import argparse
from contextlib import closing
from itertools import zip_longest
import os
from pathlib import Path
import sqlite3
import sys


ROWS = """SELECT project_key, remote_id, created_at FROM collected_ids
ORDER BY project_key COLLATE BINARY, remote_id COLLATE BINARY"""


def open_snapshot(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro")
    connection.execute("BEGIN")
    return connection


def export_data(source, output):
    """Write data-only SQL, failing on conflicts or D1's SQL size limit."""
    output = Path(output)
    with closing(open_snapshot(source)) as db:
        rows = db.execute(ROWS)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as sql:
                count = 0
                for project, remote_id, created_at in rows:
                    if (not isinstance(project, str) or not project
                            or not isinstance(remote_id, str) or not remote_id
                            or not isinstance(created_at, int)):
                        raise ValueError("source row does not match the ID Ledger schema")
                    # Hex preserves quotes, newlines and NUL bytes without SQL interpolation.
                    project_hex = project.encode("utf-8").hex()
                    id_hex = remote_id.encode("utf-8").hex()
                    statement = (
                        "INSERT INTO collected_ids(project_key,remote_id,created_at) VALUES("
                        f"CAST(X'{project_hex}' AS TEXT),CAST(X'{id_hex}' AS TEXT),{created_at});\n"
                    )
                    if len(statement.encode("utf-8")) > 100000:
                        raise ValueError("export statement exceeds D1's 100000-byte SQL limit; "
                                         "a bound-parameter import is required for this data")
                    sql.write(statement)
                    count += 1
                return count
        except BaseException:
            output.unlink(missing_ok=True)
            raise


def verify_data(source, target):
    """Compare every exact tuple, including its original timestamp, using bounded memory."""
    with closing(open_snapshot(source)) as before, closing(open_snapshot(target)) as after:
        count = 0
        for expected, actual in zip_longest(before.execute(ROWS), after.execute(ROWS)):
            if expected != actual:
                raise ValueError(f"databases differ at sorted row {count + 1}; keep writes paused")
            count += 1
        return count


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="export a read-only SQLite snapshot to a NEW SQL file")
    export.add_argument("source")
    export.add_argument("output")
    verify = commands.add_parser("verify", help="compare source and restored target SQLite snapshots")
    verify.add_argument("source")
    verify.add_argument("target")
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            count = export_data(args.source, args.output)
            print(f"Exported {count} rows; original timestamps preserved.")
        else:
            count = verify_data(args.source, args.target)
            print(f"Verified {count} exact rows, including project, ID and timestamp.")
        return 0
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
