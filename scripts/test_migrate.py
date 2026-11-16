import importlib.util
import contextlib
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("migrate", Path(__file__).with_name("migrate.py"))
migrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate)

SCHEMA = """CREATE TABLE collected_ids (
project_key TEXT COLLATE BINARY NOT NULL CHECK(project_key <> ''),
remote_id TEXT COLLATE BINARY NOT NULL CHECK(remote_id <> ''),
created_at INTEGER NOT NULL, PRIMARY KEY(project_key, remote_id)
) STRICT, WITHOUT ROWID;"""


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.db"
        self.target = self.root / "target.db"
        self.rows = [
            ("Demo", "A", 1700000000), ("Demo", "a", 1700000001),
            ("demo", "quote'\n雪\x00tail", -1),
        ]
        for path in [self.source, self.target]:
            with contextlib.closing(sqlite3.connect(path)) as db, db:
                db.executescript(SCHEMA)
        with contextlib.closing(sqlite3.connect(self.source)) as db, db:
            db.executemany("INSERT INTO collected_ids VALUES (?, ?, ?)", self.rows)

    def test_export_round_trip_keeps_exact_values_and_times(self):
        output = self.root / "data.sql"
        self.assertEqual(migrate.export_data(self.source, output), 3)
        with contextlib.closing(sqlite3.connect(self.target)) as db, db:
            db.executescript(output.read_text())
        self.assertEqual(migrate.verify_data(self.source, self.target), 3)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_verify_detects_changed_time_missing_and_extra_rows(self):
        for rows in [self.rows[:-1], self.rows + [("x", "extra", 1)],
                     [(p, i, t + 1) for p, i, t in self.rows]]:
            with self.subTest(rows=rows):
                with contextlib.closing(sqlite3.connect(self.target)) as db, db:
                    db.execute("DELETE FROM collected_ids")
                    db.executemany("INSERT INTO collected_ids VALUES (?, ?, ?)", rows)
                with self.assertRaisesRegex(ValueError, "differ"):
                    migrate.verify_data(self.source, self.target)

    def test_missing_source_is_not_created(self):
        missing = self.root / "missing.db"
        with self.assertRaises(sqlite3.OperationalError):
            migrate.export_data(missing, self.root / "data.sql")
        self.assertFalse(missing.exists())

    def test_output_is_never_overwritten(self):
        output = self.root / "data.sql"
        output.write_text("existing")
        with self.assertRaises(FileExistsError):
            migrate.export_data(self.source, output)
        self.assertEqual(output.read_text(), "existing")

    def test_oversize_statement_fails_and_removes_partial_export(self):
        with contextlib.closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO collected_ids VALUES (?, ?, ?)", ("z", "x" * 60000, 1))
        output = self.root / "data.sql"
        with self.assertRaisesRegex(ValueError, "100000"):
            migrate.export_data(self.source, output)
        self.assertFalse(output.exists())

    def test_cli_export_verify_and_failure(self):
        output = self.root / "cli.sql"
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(migrate.main(["export", str(self.source), str(output)]), 0)
            self.assertIn("Exported 3 rows", stdout.getvalue())
        with contextlib.closing(sqlite3.connect(self.target)) as db, db:
            db.executescript(output.read_text())
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(migrate.main(["verify", str(self.source), str(self.target)]), 0)
            self.assertIn("Verified 3 exact rows", stdout.getvalue())
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(migrate.main(["export", str(self.source), str(output)]), 1)
            self.assertIn("error:", stderr.getvalue())

    def test_empty_database_and_invalid_source_row(self):
        output = self.root / "empty.sql"
        self.assertEqual(migrate.export_data(self.target, output), 0)
        self.assertEqual(output.read_text(), "")
        self.assertEqual(migrate.verify_data(self.target, self.target), 0)
        invalid = self.root / "invalid.db"
        with contextlib.closing(sqlite3.connect(invalid)) as db, db:
            db.execute("CREATE TABLE collected_ids(project_key, remote_id, created_at)")
            db.execute("INSERT INTO collected_ids VALUES ('x','y','not a timestamp')")
        with self.assertRaisesRegex(ValueError, "source row"):
            migrate.export_data(invalid, self.root / "invalid.sql")
        self.assertFalse((self.root / "invalid.sql").exists())

    def test_import_does_not_silently_ignore_existing_records(self):
        output = self.root / "data.sql"
        migrate.export_data(self.source, output)
        with contextlib.closing(sqlite3.connect(self.target)) as db, db:
            db.executescript(output.read_text())
            with self.assertRaises(sqlite3.IntegrityError):
                db.executescript(output.read_text())


if __name__ == "__main__":
    unittest.main()
