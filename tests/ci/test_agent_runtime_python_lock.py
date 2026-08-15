"""PLAT-4701: agent-runtime Python lock pins exact cryptography wheel identity."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REQ = ROOT / "requirements-agent-runtime.txt"
DOCKERFILE = ROOT / "Dockerfile.agent-runtime"


class AgentRuntimePythonLockTests(unittest.TestCase):
    def _pinned_version(self):
        text = REQ.read_text()
        pins = re.findall(r"(?m)^cryptography==([0-9]+(?:\.[0-9]+){2})\s*$", text)
        self.assertEqual(pins, ["50.0.0"], text)
        self.assertNotRegex(text, r"(?m)^cryptography==2\.6")
        self.assertNotIn(">=", text)
        return pins[0]

    def test_requirements_pins_exact_cryptography(self):
        self._pinned_version()

    def test_dockerfile_derives_import_assertion_from_the_lock(self):
        expected = self._pinned_version()
        text = DOCKERFILE.read_text()
        self.assertIn("requirements-agent-runtime.txt", text)
        self.assertIn("--only-binary=:all:", text)

        # Extract the cryptography install RUN (first pip3 after COPY requirements).
        match = re.search(
            r"COPY requirements-agent-runtime\.txt[^\n]*\nRUN pip3 install[^\n]*(?:\n[^\n]*){0,6}",
            text,
        )
        self.assertIsNotNone(match, "cryptography install RUN not found")
        crypto_run = match.group(0)
        self.assertIn("--only-binary=:all:", crypto_run)
        self.assertIn("-r /tmp/requirements-agent-runtime.txt", crypto_run)
        self.assertIn("line.startswith('cryptography==')", crypto_run)
        self.assertIn("cryptography.__version__ == pins[0]", crypto_run)
        self.assertNotIn(f"== '{expected}'", crypto_run)

        # Must not reintroduce an unbounded cryptography package token in any RUN list.
        free = re.findall(r"(?m)^\s+.*\bcryptography\b.*$", text)
        for line in free:
            if "assert" in line or "PLAT-4701" in line or "locked" in line or "requirements" in line:
                continue
            if "cryptography==" in line or "cryptography>=" in line or re.search(r"\bcryptography\b(?!\.)", line):
                if re.search(r"(^|[\s\"'])cryptography([<>=!~\s\"']|$)", line) and "assert" not in line:
                    self.fail(f"unbounded cryptography token in Dockerfile: {line!r}")


if __name__ == "__main__":
    unittest.main()
