#!/usr/bin/env python3
"""Verify ingress GET/conditional PUT/readback using a local cf stub only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


VM = Path(__file__).resolve().parents[1]
INGRESS = [
    {'hostname': 'ma-vm.expii.top', 'service': 'http://localhost:8090'},
    {'hostname': '*.expii.top', 'service': 'http://localhost:8080'},
    {'service': 'http_status:404'},
]
CF = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ['MA_TEST_ROOT'])
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
state = json.loads((root / 'state.json').read_text())
tunnel = {'id': 'dummy-tunnel-id', 'name': 'min-atoms',
          'config_src': 'cloudflare', 'deleted_at': None}
if args == ['auth', 'whoami']:
    result = {'id': 'dummy-account'}
elif args == ['tunnels', 'list', '--name', 'min-atoms', '--is-deleted=false']:
    result = [tunnel]
elif args == ['tunnels', 'get', 'dummy-tunnel-id']:
    if state.get('unsafe_tunnel'):
        tunnel['config_src'] = 'local'
    result = tunnel
elif args == ['tunnels', 'config', 'get', 'dummy-tunnel-id']:
    if state.get('fail_get'):
        sys.exit(7)
    result = {'config': {'ingress': state['ingress']}, 'version': 12}
elif args[:4] == ['tunnels', 'config', 'update', 'dummy-tunnel-id']:
    assert args[4] == '--body' and len(args) == 6, args
    if not state.get('bad_readback'):
        state['ingress'] = json.loads(args[5])['config']['ingress']
    (root / 'state.json').write_text(json.dumps(state))
    result = {}
elif args[:3] == ['dns', 'records', 'list']:
    assert args[3:6] == ['--zone', 'expii.top', '--name'], args
    assert len(args) == 7, args
    result = [record for record in state['records'] if record['name'] == args[6]]
    assert len(result) == 1, args
elif args[:3] == ['dns', 'records', 'get']:
    assert args[4:] == ['--zone', 'expii.top'], args
    result = next(record for record in state['records'] if record['id'] == args[3])
else:
    raise AssertionError('Unexpected or unscoped command: ' + repr(args))
print(json.dumps(result))
'''


class IngressTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ma-ingress-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        config = self.root / 'private'
        config.mkdir()
        # Fixed test labels are dummy inputs, never a real preview pool.
        names = [f'ma-test{i:04d}.expii.top' for i in range(1, 31)]
        (config / 'preview-hosts.txt').write_text('\n'.join(names) + '\n')
        self.state = {
            'ingress': INGRESS,
            'records': [
                {'id': f'dummy-record-{i}', 'name': name, 'type': 'CNAME',
                 'content': 'dummy-tunnel-id.cfargotunnel.com',
                 'proxied': True, 'comment': 'min-atoms'}
                for i, name in enumerate(['ma-vm.expii.top', *names])
            ],
        }
        stub = self.root / 'cf-stub'
        stub.write_text(CF)
        stub.chmod(0o700)
        hook = self.root / 'bash-env'
        hook.write_text('source() { builtin source "$@"; export MA_CONFIG="$MA_TEST_CONFIG"; }\n')
        self.env = dict(os.environ, CF_BIN=str(stub), BASH_ENV=str(hook),
                        MA_TEST_CONFIG=str(config), MA_TEST_ROOT=str(self.root))

    def run_script(self, *args):
        (self.root / 'state.json').write_text(json.dumps(self.state))
        result = subprocess.run(['bash', str(VM / 'cloudflare.sh'), *args],
                                env=self.env, capture_output=True, timeout=20)
        log = self.root / 'calls.jsonl'
        calls = [json.loads(line) for line in log.read_text().splitlines()] \
            if log.exists() else []
        return result, calls

    def test_matching_ingress_skips_put_and_still_verifies_all_dns(self):
        # Object key ordering is immaterial to structural ingress equality.
        self.state['ingress'] = [dict(reversed(list(rule.items()))) for rule in INGRESS]
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual([call[2] for call in calls if call[:2] == ['tunnels', 'config']], ['get'])
        self.assertEqual(sum(call[:3] == ['dns', 'records', 'get'] for call in calls), 31)

    def test_different_ingress_updates_once_then_reads_back(self):
        self.state['ingress'] = list(reversed(INGRESS))
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual([call[2] for call in calls if call[:2] == ['tunnels', 'config']],
                         ['get', 'update', 'get'])
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['ingress'], INGRESS)

    def test_failed_get_never_attempts_put(self):
        self.state['fail_get'] = True
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 7)
        self.assertEqual([call[2] for call in calls if call[:2] == ['tunnels', 'config']], ['get'])
        self.assertFalse(any(call[0] == 'dns' for call in calls))

    def test_mismatched_readback_stops_before_dns(self):
        self.state.update(ingress=[], bad_readback=True)
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'Ingress readback differs.', result.stderr)
        self.assertEqual([call[2] for call in calls if call[:2] == ['tunnels', 'config']],
                         ['get', 'update', 'get'])
        self.assertFalse(any(call[0] == 'dns' for call in calls))

    def test_ownership_checks_remain_strict(self):
        self.state['unsafe_tunnel'] = True
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(any(call[:2] == ['tunnels', 'config'] for call in calls))

    def test_dry_run_never_calls_cf_or_creates_private_inputs(self):
        missing = self.root / 'missing-private-inputs'
        self.env['MA_TEST_CONFIG'] = str(missing)
        result, calls = self.run_script('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(calls, [])
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
