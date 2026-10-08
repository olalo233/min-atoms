#!/usr/bin/env python3
"""Exercise credential transport with dummy inputs and local CLI stubs only."""
import base64
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import secrets
import subprocess
import tarfile
import tempfile
import unittest


VM = Path(__file__).resolve().parents[1]
KEY = 'dummy-model-key-' + secrets.token_hex(8) + '-"\\$`-only-for-tests'
LOCAL_ENV = 'TUNNEL_TOKEN=dummy-tunnel\nMA_SHARED_SECRET=dummy-shared'
GCLOUD = r'''#!/usr/bin/env python3
import base64, json, os, sys
args = sys.argv[1:]
assert '--project=hy2-seoul-relay-20260728' in args
assert '--zone=asia-northeast1-b' in args
assert 'min-atoms-vm' in args
if args[:3] == ['compute', 'instances', 'describe']:
    payload = b''
    print(json.dumps({'name': 'min-atoms-vm', 'labels': {'app': 'min-atoms'},
        'zone': 'zones/asia-northeast1-b', 'machineType': 'types/e2-standard-4',
        'serviceAccounts': []}))
else:
    assert args[:2] == ['compute', 'ssh'], args
    payload = sys.stdin.buffer.read()
with open(os.environ['MA_TEST_CAPTURE'], 'a') as capture:
    capture.write(json.dumps({'args': args,
        'stdin': base64.b64encode(payload).decode()}) + '\n')
'''


class PrivateEnvTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ma-private-env-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(VM, self.root / 'infra/vm')
        shutil.copytree(VM.parent / 'gateway', self.root / 'infra/gateway')
        for path in ('apps/manager', 'packages', 'templates/fullstack', 'infra/image'):
            (self.root / path).mkdir(parents=True, exist_ok=True)
        for path in ('package.json', 'bun.lock', 'templates/fullstack/AGENTS.md'):
            (self.root / path).write_text('dummy deployment input\n')
        self.config = self.root / 'private'
        self.config.mkdir(mode=0o700)
        (self.config / 'env').write_text(LOCAL_ENV)
        (self.config / 'deepseek.key').write_text(KEY + '\n')
        for path in self.config.iterdir():
            path.chmod(0o600)
        bindir = self.root / 'bin'
        bindir.mkdir()
        for name, content in (
            ('gcloud', GCLOUD),
            ('curl', '#!/usr/bin/env python3\nprint(\'{"ok":true}\')\n'),
        ):
            script = bindir / name
            script.write_text(content)
            script.chmod(0o700)
        # Override only the test config after common.sh loads; leave HOME intact.
        hook = self.root / 'bash-env'
        hook.write_text('source() { builtin source "$@"; export MA_CONFIG="$MA_TEST_CONFIG"; }\n')
        self.capture = self.root / 'capture.jsonl'
        self.env = dict(os.environ, PATH=f'{bindir}:{os.environ["PATH"]}',
                        BASH_ENV=str(hook), MA_TEST_CONFIG=str(self.config),
                        MA_TEST_CAPTURE=str(self.capture))

    def run_script(self, name, *args):
        self.capture.unlink(missing_ok=True)
        result = subprocess.run(['bash', str(self.root / 'infra/vm' / name), *args],
                                env=self.env, input=b'', capture_output=True, timeout=20)
        calls = [json.loads(line) for line in self.capture.read_text().splitlines()] \
            if self.capture.exists() else []
        return result, calls

    def test_bootstrap_and_deploy_send_one_env_payload(self):
        escaped_key = KEY.replace('\\', '\\\\').replace('"', '\\"')
        expected = (LOCAL_ENV + '\nDEEPSEEK_API_KEY="' + escaped_key + '"\n').encode()
        for name in ('bootstrap.sh', 'deploy.sh'):
            with self.subTest(script=name):
                result, calls = self.run_script(name)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertNotIn(KEY.encode(), result.stdout + result.stderr)
                env_payloads = []
                for call in calls:
                    argv = '\n'.join(call['args'])
                    payload = base64.b64decode(call['stdin'])
                    self.assertNotIn(KEY, argv)
                    self.assertNotIn('/etc/min-atoms/deepseek.key', argv)
                    if any('cat > /etc/min-atoms/env' in arg for arg in call['args']):
                        self.assertIn('install -m 0600 /dev/null /etc/min-atoms/env', argv)
                        env_payloads.append(payload)
                    elif payload:
                        # Source archives must never become another VM key copy.
                        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
                            for member in archive.getmembers():
                                if member.isfile():
                                    self.assertNotIn(KEY.encode(), archive.extractfile(member).read())
                self.assertEqual(env_payloads, [expected])
                self.assertEqual(expected.count(b'DEEPSEEK_API_KEY='), 1)
                self.assertEqual((self.config / 'env').read_text(), LOCAL_ENV)
                self.assertEqual((self.config / 'deepseek.key').read_text(), KEY + '\n')

    def test_dry_run_never_reads_private_inputs_or_calls_gcloud(self):
        self.env['MA_TEST_CONFIG'] = str(self.root / 'missing-private-inputs')
        for name in ('up.sh', 'bootstrap.sh', 'deploy.sh', 'gateway.sh'):
            with self.subTest(script=name):
                result, calls = self.run_script(name, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(calls, [])
                self.assertNotIn('/etc/min-atoms/deepseek.key', result.stdout.decode())

    def test_local_env_cannot_be_a_second_model_key_source(self):
        (self.config / 'env').write_text(LOCAL_ENV + '\nDEEPSEEK_API_KEY=dummy-copy\n')
        for name in ('bootstrap.sh', 'deploy.sh'):
            result, calls = self.run_script(name)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'Keep DEEPSEEK_API_KEY out of the local env', result.stderr)
            self.assertFalse(any(call['args'][:2] == ['compute', 'ssh'] for call in calls))

    def test_empty_or_multiline_key_is_rejected_before_remote_write(self):
        for key in ('', 'dummy-first\ndummy-second\n', 'dummy-key\r\n'):
            (self.config / 'deepseek.key').write_text(key)
            for name in ('bootstrap.sh', 'deploy.sh'):
                with self.subTest(key=repr(key), script=name):
                    result, calls = self.run_script(name)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn(b'Invalid local DeepSeek key file', result.stderr)
                    self.assertNotIn(b'dummy-', result.stdout + result.stderr)
                    self.assertFalse(any(call['args'][:2] == ['compute', 'ssh'] for call in calls))

    def test_units_and_gateway_limit_key_to_gateway_container(self):
        for name in ('ma-manager.service', 'ma-cloudflared.service'):
            unit = (VM / name).read_text()
            self.assertIn('EnvironmentFile=/etc/min-atoms/env\n', unit)
            self.assertIn('UnsetEnvironment=DEEPSEEK_API_KEY\n', unit)
        self.assertIn('EnvironmentFile=/etc/min-atoms/env\n',
                      (VM / 'ma-gateway.service').read_text())
        result, _ = self.run_script('gateway.sh', '--dry-run')
        command = next(line for line in result.stdout.decode().splitlines()
                       if line.startswith('+ docker run '))
        argv = shlex.split(command[2:])
        self.assertEqual([argv[i + 1] for i, arg in enumerate(argv) if arg == '--env'],
                         ['DEEPSEEK_API_KEY'])
        self.assertNotIn('--env-file', argv)
        self.assertNotIn('/etc/min-atoms/deepseek.key', (VM / 'gateway.sh').read_text())


if __name__ == '__main__':
    unittest.main()
