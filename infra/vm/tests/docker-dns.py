#!/usr/bin/env python3
"""Run the host installer against fake files and local command stubs only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


VM = Path(__file__).resolve().parents[1]
STUB = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
config = Path(os.environ['MA_TEST_DAEMON'])
with open(os.environ['MA_TEST_CALLS'], 'a') as log:
    log.write(json.dumps({'command': [name, *args],
        'config': json.loads(config.read_text()) if config.exists() else None}) + '\n')
if name in ('docker', 'gcloud', 'cf', 'bun'):
    sys.exit(99)  # Unexpected invocation: no real Docker, cloud, or dry-run Bun.
if name == 'systemctl' and args == ['is-active', '--quiet', 'docker.service']:
    sys.exit(0 if os.environ['MA_TEST_ACTIVE'] == 'true' else 3)
'''


class DockerDnsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='ma-docker-dns-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.vm = self.root / 'infra/vm'
        shutil.copytree(VM, self.vm)
        self.daemon = self.root / 'etc/docker/daemon.json'
        self.apt = self.root / 'etc/apt/sources.list.d/cloudflared.list'
        self.apt.parent.mkdir(parents=True)
        self.calls = self.root / 'calls.jsonl'
        # Relocate only absolute file paths; execute the installer logic unchanged.
        installer = self.vm / 'install-host.sh'
        installer.write_text(installer.read_text()
                             .replace('/etc/docker/daemon.json', str(self.daemon))
                             .replace('/etc/apt/sources.list.d/cloudflared.list', str(self.apt)))
        hook = self.root / 'bash-env'
        # Stub the root requirement so tests can run unprivileged. All host IO
        # commands are stubs and both shell/helper file writes are relocated.
        hook.write_text('''source() {
  builtin source "$@"
  die() {
    if [[ "$*" == 'Run as root on the VM.' ]]; then return; fi
    printf '%s\\n' "$*" >&2; exit 1
  }
}
''')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('apt-get', 'curl', 'unzip', 'install', 'rm',
                     'systemctl', 'docker', 'gcloud', 'cf'):
            script = self.bin / name
            script.write_text(STUB)
            script.chmod(0o700)
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        BASH_ENV=str(hook), MA_TEST_DAEMON=str(self.daemon),
                        MA_TEST_CALLS=str(self.calls), MA_TEST_ACTIVE='true')

    def write_config(self, config):
        self.daemon.parent.mkdir(parents=True, exist_ok=True)
        self.daemon.write_text(json.dumps(config) + '\n')
        self.daemon.chmod(0o640)

    def run_installer(self, *args):
        self.calls.unlink(missing_ok=True)
        result = subprocess.run(['bash', str(self.vm / 'install-host.sh'), *args],
                                env=self.env, capture_output=True, timeout=20)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] \
            if self.calls.exists() else []
        return result, calls

    def assert_lifecycle(self, calls, restarted):
        commands = [call['command'] for call in calls]
        reload = commands.index(['systemctl', 'daemon-reload'])
        enabled = commands.index(['systemctl', 'enable', 'ma-firewall.service',
                                  'ma-gateway.service', 'ma-manager.service',
                                  'ma-cloudflared.service'])
        docker_start = commands.index(['systemctl', 'enable', '--now', 'docker.service'])
        services = commands.index(['systemctl', 'restart', 'ma-firewall.service',
                                   'ma-gateway.service', 'ma-manager.service',
                                   'ma-cloudflared.service'])
        self.assertLess(reload, enabled)
        self.assertLess(enabled, docker_start)
        self.assertLess(docker_start, services)
        for unit in ('ma-firewall', 'ma-gateway', 'ma-manager', 'ma-cloudflared'):
            installed = commands.index(['install', '-m', '0644',
                                        str(self.vm / f'{unit}.service'),
                                        f'/etc/systemd/system/{unit}.service'])
            self.assertLess(installed, reload)
        restarts = [i for i, command in enumerate(commands)
                    if command == ['systemctl', 'restart', 'docker.service']]
        self.assertEqual(len(restarts), int(restarted))
        if restarted:
            self.assertLess(enabled, restarts[0])
            self.assertLess(restarts[0], docker_start)
        self.assertEqual(calls[docker_start]['config']['dns'], ['8.8.8.8'])
        if restarted:
            self.assertEqual(calls[restarts[0]]['config']['dns'], ['8.8.8.8'])

    def test_fresh_config_handles_inactive_and_package_started_docker(self):
        for active in ('false', 'true'):
            with self.subTest(docker_active=active):
                self.env['MA_TEST_ACTIVE'] = active
                result, calls = self.run_installer()
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(json.loads(self.daemon.read_text()), {'dns': ['8.8.8.8']})
                self.assertEqual(self.daemon.stat().st_mode & 0o777, 0o644)
                self.assertEqual(list(self.daemon.parent.iterdir()), [self.daemon])
                self.assert_lifecycle(calls, restarted=active == 'true')
                self.daemon.unlink()
                self.daemon.parent.rmdir()

    def test_changed_config_preserves_unrelated_fields_and_restarts_active_docker(self):
        config = {'dns': ['169.254.169.254', '1.1.1.1'], 'live-restore': True,
                  'log-driver': 'local', 'log-opts': {'max-size': '10m'},
                  'default-address-pools': [{'base': '172.30.0.0/16', 'size': 24}]}
        self.write_config(config)
        result, calls = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(self.daemon.read_text()), dict(config, dns=['8.8.8.8']))
        self.assertEqual(self.daemon.stat().st_mode & 0o777, 0o640)
        self.assert_lifecycle(calls, restarted=True)

    def test_unchanged_second_run_preserves_file_and_skips_docker_restart(self):
        self.write_config({'log-driver': 'local'})
        first, first_calls = self.run_installer()
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        self.assert_lifecycle(first_calls, restarted=True)
        before = self.daemon.read_bytes(), self.daemon.stat().st_mtime_ns, self.daemon.stat().st_ino
        second, calls = self.run_installer()
        self.assertEqual(second.returncode, 0, second.stderr.decode())
        self.assertEqual(before, (self.daemon.read_bytes(), self.daemon.stat().st_mtime_ns,
                                  self.daemon.stat().st_ino))
        self.assert_lifecycle(calls, restarted=False)
        self.assertNotIn(['systemctl', 'is-active', '--quiet', 'docker.service'],
                         [call['command'] for call in calls])

    def test_dry_run_never_reads_or_writes_config_or_invokes_host_commands(self):
        # Invalid JSON demonstrates dry-run does not parse the file either.
        self.write_config({})
        self.daemon.write_text('deliberately invalid JSON\n')
        before = self.daemon.read_bytes(), self.daemon.stat().st_mtime_ns
        stub = self.bin / 'bun'
        stub.write_text(STUB)
        stub.chmod(0o700)
        for exists in (True, False):
            with self.subTest(existing_config=exists):
                if not exists:
                    self.daemon.unlink()
                    self.daemon.parent.rmdir()
                result, calls = self.run_installer('--dry-run')
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(calls, [])
                self.assertFalse(self.apt.exists())
                self.assertIn(b'set dns:["8.8.8.8"]', result.stdout)
                self.assertIn(b'If DNS changed and docker.service is active', result.stdout)
                self.assertEqual(self.daemon.exists(), exists)
                if exists:
                    self.assertEqual(before, (self.daemon.read_bytes(), self.daemon.stat().st_mtime_ns))
                else:
                    self.assertFalse(self.daemon.parent.exists())

    def test_invalid_config_stops_without_overwriting_or_starting_docker(self):
        self.write_config([])
        before = self.daemon.read_bytes()
        result, calls = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.daemon.read_bytes(), before)
        commands = [call['command'] for call in calls]
        self.assertNotIn(['systemctl', 'restart', 'docker.service'], commands)
        self.assertNotIn(['systemctl', 'enable', '--now', 'docker.service'], commands)

    def test_docker_lifecycle_keeps_metadata_firewall_before_project_services(self):
        for unit in ('ma-firewall', 'ma-gateway', 'ma-manager'):
            text = (VM / f'{unit}.service').read_text()
            self.assertIn('PartOf=docker.service\n', text)
            self.assertIn('WantedBy=docker.service\n', text)
        firewall = (VM / 'ma-firewall.service').read_text()
        self.assertIn('After=docker.service\n', firewall)
        self.assertIn('Before=ma-gateway.service ma-manager.service\n', firewall)
        for unit in ('ma-gateway', 'ma-manager'):
            after = next(line for line in (VM / f'{unit}.service').read_text().splitlines()
                         if line.startswith('After='))
            self.assertIn('ma-firewall.service', after)
        self.assertIn('iptables -C DOCKER-USER -d 169.254.169.254 -j DROP',
                      (VM / 'firewall.sh').read_text())
        self.assertIn('iptables -I DOCKER-USER -d 169.254.169.254 -j DROP',
                      (VM / 'firewall.sh').read_text())


if __name__ == '__main__':
    unittest.main()
