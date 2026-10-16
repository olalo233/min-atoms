#!/usr/bin/env python3
"""Verify idle shutdown using local health and poweroff stubs; no host mutations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


VM = Path(__file__).resolve().parents[1]
STUB = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
with open(os.environ['MA_TEST_CALLS'], 'a') as log:
    log.write(json.dumps([name, *sys.argv[1:]]) + '\n')
if name == 'curl':
    assert sys.argv[-1] == 'http://127.0.0.1:8090/health'
    print(os.environ['MA_TEST_HEALTH'])
    sys.exit(int(os.environ.get('MA_TEST_CURL_EXIT', '0')))
assert name == 'systemctl' and sys.argv[1:] == ['poweroff'], sys.argv
'''


class SpotIdleTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ma-spot-idle-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        # Bypass only the root guard; all effects remain behind command stubs.
        self.script = self.root / 'idle-check.sh'
        self.script.write_text((VM / 'idle-check.sh').read_text().replace('[[ $EUID == 0 ]] ||', 'true ||', 1))
        self.calls = self.root / 'calls.jsonl'
        bindir = self.root / 'bin'
        bindir.mkdir()
        for name in ('curl', 'systemctl'):
            stub = bindir / name
            stub.write_text(STUB)
            stub.chmod(0o700)
        self.env = dict(os.environ, PATH=f'{bindir}:{os.environ["PATH"]}', MA_TEST_CALLS=str(self.calls))
        self.env.pop('MA_IDLE_SHUTDOWN_SECONDS', None)

    def run_check(self, body, threshold=None, curl_exit=0):
        self.calls.unlink(missing_ok=True)
        env = dict(self.env, MA_TEST_HEALTH=body, MA_TEST_CURL_EXIT=str(curl_exit))
        if threshold is not None:
            env['MA_IDLE_SHUTDOWN_SECONDS'] = str(threshold)
        result = subprocess.run(['bash', str(self.script)], env=env, capture_output=True, timeout=20)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return result, calls

    def test_default_and_custom_threshold_boundaries(self):
        for threshold, seconds, poweroff in ((None, 1799, False), (None, 1800, True),
                                             (None, 1801, True), (60, 59, False), (60, 60, True)):
            with self.subTest(threshold=threshold, idle=seconds):
                result, calls = self.run_check(json.dumps({'ok': True, 'idleSeconds': seconds}), threshold)
                self.assertEqual(['systemctl', 'poweroff'] in calls, poweroff)
                self.assertEqual(b'powering off' in result.stdout, poweroff)

    def test_zero_disables_without_even_polling_health(self):
        _, calls = self.run_check('{"ok":true,"idleSeconds":3600}', threshold=0)
        self.assertEqual(calls, [])

    def test_uncertain_health_or_configuration_never_powers_off(self):
        for body, threshold, curl_exit in (
            ('{"ok":true,"idleSeconds":3600}', None, 22),
            ('{"ok":true}', None, 0), ('invalid json', None, 0), ('', None, 0),
            ('null', None, 0), ('{"ok":false,"idleSeconds":3600}', None, 0),
            ('{"ok":true,"idleSeconds":"3600"}', None, 0),
            ('{"ok":true,"idleSeconds":-1}', None, 0),
            ('{"ok":true,"idleSeconds":1800.5}', None, 0),
            ('{"ok":true,"idleSeconds":3600}', 'invalid', 0),
        ):
            with self.subTest(body=body, threshold=threshold, curl_exit=curl_exit):
                _, calls = self.run_check(body, threshold, curl_exit)
                self.assertFalse(any(call[0] == 'systemctl' for call in calls))

    def test_timer_and_service_configuration(self):
        timer = (VM / 'ma-idle.timer').read_text()
        self.assertIn('OnBootSec=15min\n', timer)
        self.assertIn('OnUnitActiveSec=5min\n', timer)
        self.assertIn('WantedBy=timers.target\n', timer)
        service = (VM / 'ma-idle.service').read_text()
        self.assertIn('Type=oneshot\n', service)
        self.assertIn('ExecStart=/bin/bash /opt/min-atoms/infra/vm/idle-check.sh\n', service)
        self.assertIn('EnvironmentFile=-/etc/min-atoms/idle.conf\n', service)


if __name__ == '__main__':
    unittest.main()
