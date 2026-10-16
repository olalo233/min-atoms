#!/usr/bin/env python3
"""Exercise deep archive orchestration with local gcloud/cf stubs and a fake bucket."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


VM = Path(__file__).resolve().parents[1]
ARCHIVE = gzip.compress(b'fake projects tar \x00\xff', mtime=0)
PROJECTS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
GCLOUD = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
root = Path(os.environ['MA_TEST_ROOT'])
state = json.loads((root / 'vm.json').read_text())
args = sys.argv[1:]
def record(entry):
    with open(root / 'calls.jsonl', 'a') as calls:
        calls.write(json.dumps(entry) + '\n')
assert '--project=hy2-seoul-relay-20260728' in args
def save():
    (root / 'vm.json').write_text(json.dumps(state))
def snapshot_info(name):
    index = state['snapshots'].index(name)
    return {'name': name, 'status': state.get('snapshotStatuses', {}).get(name, state['snapshotStatus']),
            'creationTimestamp': f'2026-10-{10 + index:02d}T06:00:00Z',
            'labels': {'app': state.get('snapshotLabels', {}).get(name, 'min-atoms')},
            'sourceDisk': 'https://x/projects/p/zones/asia-northeast1-b/disks/min-atoms-vm'}
if args[:3] == ['compute', 'instances', 'list']:
    print(json.dumps([] if state['deleted'] else [{'name': 'min-atoms-vm', 'status': state['status']}]))
    sys.exit()
if args[:3] == ['compute', 'disks', 'list']:
    print(json.dumps([] if state['deleted'] else [{'name': 'min-atoms-vm'}]))
    sys.exit()
if args[:3] == ['compute', 'snapshots', 'create']:
    assert {'--source-disk=min-atoms-vm', '--source-disk-zone=asia-northeast1-b',
            '--storage-location=asia-northeast1', '--labels=app=min-atoms'} <= set(args), args
    record({'tool': 'gcloud', 'op': 'snapshot'})
    state['snapshots'].append(args[3])
    save()
    sys.exit()
if args[:3] == ['compute', 'snapshots', 'describe']:
    snapshot = snapshot_info(args[3])
    print(json.dumps(snapshot) if '--format=json' in args else snapshot['status'])
    sys.exit()
if args[:3] == ['compute', 'snapshots', 'list']:
    if '--format=json' in args:
        assert '--filter=labels.app=min-atoms' in args, args
        print(json.dumps([snapshot_info(name) for name in state['snapshots']]))
        sys.exit()
    assert "--filter=labels.app=min-atoms AND status=READY" in args, args
    print(state['snapshots'][-1] if state['snapshots'] else '')
    sys.exit()
if args[:3] == ['compute', 'snapshots', 'delete']:
    assert state['deleted'], 'pruning must follow VM deletion readback'
    record({'tool': 'gcloud', 'op': 'prune', 'name': args[3]})
    if not os.environ.get('MA_TEST_PRUNE_STUCK'):
        state['snapshots'].remove(args[3])
    save()
    sys.exit()
assert '--zone=asia-northeast1-b' in args
if args[:3] == ['compute', 'instances', 'create']:
    assert {'--machine-type=t2d-standard-2', '--provisioning-model=SPOT',
            '--instance-termination-action=STOP', '--boot-disk-size=50GB',
            '--boot-disk-type=pd-balanced', '--labels=app=min-atoms',
            '--no-service-account', '--no-scopes'} <= set(args), args
    keys = next(a for a in args if a.startswith('--metadata-from-file=ssh-keys='))
    record({'tool': 'gcloud', 'op': 'create', 'source': [a for a in args if a.startswith(('--source-snapshot', '--image'))],
            'metadata': [a for a in args if a.startswith('--metadata=')],
            'sshKeys': open(keys.split('=', 2)[2]).read()})
    state.update(deleted=False, status='RUNNING', machineType='t2d-standard-2')
    save()
    sys.exit()
if args[:3] == ['compute', 'instances', 'describe']:
    fmt = next(arg for arg in args if arg.startswith('--format='))[9:]
    if fmt == 'json':
        print(json.dumps({'name': 'min-atoms-vm', 'labels': {'app': 'min-atoms'},
            'zone': 'zones/asia-northeast1-b', 'machineType': 'types/' + state.get('machineType', 'e2-standard-4'),
            'serviceAccounts': [], 'metadata': {'items': [{'key': 'block-project-ssh-keys', 'value': 'true'}]}}))
    elif fmt == 'value(status)':
        print(state['status'])
    else:
        assert fmt.startswith('value(lastStartTimestamp.date('), fmt
        print(state['lastStart'])
    sys.exit()
if args[:3] in (['compute', 'instances', 'stop'], ['compute', 'instances', 'delete']):
    record({'tool': 'gcloud', 'op': args[2]})
    state['status'] = 'TERMINATED'
    state['deleted'] = args[2] == 'delete'
    save()
    sys.exit()
assert args[:3] == ['compute', 'ssh', 'tmars@min-atoms-vm'], args
command = next(arg for arg in args if arg.startswith('--command='))[10:]
# Parse exactly as the remote login shell (bash) would, including $'...' quoting.
argv = subprocess.run(['bash', '-c', 'eval "set -- $1"; printf "%s\\0" "$@"', '_', command],
                      capture_output=True, check=True).stdout.decode().split('\0')[:-1]
assert argv[:3] == ['sudo', 'bash', '-c'], argv
# Command substitution drops only the trailing newline.
assert argv[3] == (root / 'infra/vm/archive-host.sh').read_text().rstrip('\n'), 'host script must be streamed verbatim'
assert argv[4] == 'archive-host.sh', argv
step = argv[5:]
stdin = sys.stdin.buffer.read() if step[0] in ('verify', 'stage') else b''
record({'tool': 'ssh', 'step': step, 'stdin': stdin.hex()})
if step[0] == 'list':
    print('\n'.join(state['projects']))
elif step[0] == 'pack':
    sys.stdout.buffer.write(bytes.fromhex(state['archive']))
elif step[0] == 'verify' and stdin != bytes.fromhex(state['archive']):
    sys.exit(1)
'''
CF = r'''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ['MA_TEST_ROOT'])
bucket = root / 'bucket'
args = sys.argv[1:]
def record(entry):
    with open(root / 'calls.jsonl', 'a') as calls:
        calls.write(json.dumps(entry) + '\n')
if args[:2] == ['auth', 'whoami']:
    print('{"authenticated": true}')
elif args[:3] == ['r2', 'buckets', 'list']:
    print(json.dumps({'buckets': [{'name': 'min-atoms-archive'}] if bucket.exists() else []}))
elif args[:3] == ['r2', 'buckets', 'create']:
    assert args[3:] == ['--name', 'min-atoms-archive', '--location-hint', 'apac'], args
    record({'tool': 'cf', 'op': 'create-bucket'})
    bucket.mkdir()
elif args[:3] == ['r2', 'objects', 'put']:
    key, source = args[3], args[args.index('--file') + 1]
    assert args[args.index('--bucket-name') + 1] == 'min-atoms-archive'
    record({'tool': 'cf', 'op': 'put', 'key': key})
    (bucket / key).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, bucket / key)
elif args[:3] == ['r2', 'objects', 'get']:
    path = bucket / args[3]
    if not path.is_file():
        print('[10007] The specified key does not exist.', file=sys.stderr)
        sys.exit(1)
    body = path.read_bytes()
    if any(args[3].endswith(suffix) for suffix in os.environ.get('MA_TEST_CORRUPT', '').split()):
        body += b'corrupted in transit'
    sys.stdout.buffer.write(body)
else:
    record({'tool': 'cf', 'op': ' '.join(args[:3])})
'''


class DeepArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ma-deep-archive-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(VM, self.root / 'infra/vm')
        self.config = self.root / 'private'
        self.config.mkdir(mode=0o700)
        bindir = self.root / 'bin'
        bindir.mkdir()
        for name, content in (('gcloud', GCLOUD), ('cf', CF),
                              ('curl', '#!/usr/bin/env python3\nprint(\'{"ok":true}\')\n')):
            (bindir / name).write_text(content)
            (bindir / name).chmod(0o700)
        (self.root / '.ssh').mkdir()
        (self.root / '.ssh/google_compute_engine.pub').write_text('ssh-rsa AAAATEST tmars@laptop\n')
        hook = self.root / 'bash-env'
        hook.write_text('source() { builtin source "$@"; export MA_CONFIG="$MA_TEST_CONFIG"; }\n')
        self.env = dict(os.environ, HOME=str(self.root), PATH=f'{bindir}:{os.environ["PATH"]}', BASH_ENV=str(hook),
                        MA_TEST_CONFIG=str(self.config), MA_TEST_ROOT=str(self.root))
        self.vm(status='RUNNING', lastStart='2026-10-16T01:00:00Z')

    def vm(self, **changes):
        path = self.root / 'vm.json'
        state = json.loads(path.read_text()) if path.exists() else {
            'deleted': False, 'projects': PROJECTS, 'archive': ARCHIVE.hex(),
            'snapshots': [], 'snapshotStatus': 'READY'}
        state.update(changes)
        path.write_text(json.dumps(state))

    def run_script(self, name, *args):
        (self.root / 'calls.jsonl').unlink(missing_ok=True)
        result = subprocess.run(['bash', str(self.root / 'infra/vm' / name), *args],
                                env=self.env, capture_output=True, timeout=30)
        calls = self.root / 'calls.jsonl'
        return result, [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def put_object(self, key, body):
        path = self.root / 'bucket' / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    def put_archive(self, stamp='20261016T020000Z', sha256=None):
        prefix = f'archives/{stamp}'
        self.put_object(f'{prefix}/projects.tar.gz', ARCHIVE)
        manifest = {'format': 1, 'createdAt': f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}Z',
                    'projects': PROJECTS, 'archive': {'key': f'{prefix}/projects.tar.gz', 'bytes': len(ARCHIVE),
                    'sha256': sha256 or hashlib.sha256(ARCHIVE).hexdigest()}}
        self.put_object(f'{prefix}/manifest.json', json.dumps(manifest).encode())
        self.put_object('latest.json', json.dumps({'manifest': f'{prefix}/manifest.json'}).encode())

    def test_archive_publishes_pointer_last_then_stops_vm(self):
        result, calls = self.run_script('archive.sh')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        steps = [call['step'][0] for call in calls if call['tool'] == 'ssh']
        self.assertEqual(steps, ['freeze', 'list', 'pack', 'verify'])
        verify = next(call for call in calls if call['tool'] == 'ssh' and call['step'][0] == 'verify')
        self.assertEqual(bytes.fromhex(verify['stdin']), ARCHIVE)
        mutations = [call.get('key', call.get('op')) for call in calls if call['tool'] in ('cf', 'gcloud')]
        self.assertEqual(mutations[0], 'create-bucket')
        self.assertTrue(mutations[1].endswith('/projects.tar.gz'))
        self.assertTrue(mutations[2].endswith('/manifest.json'))
        self.assertEqual(mutations[3:], ['latest.json', 'stop'])
        pointer = json.loads((self.root / 'bucket/latest.json').read_text())
        manifest = json.loads((self.root / 'bucket' / pointer['manifest']).read_text())
        self.assertEqual(manifest['projects'], PROJECTS)
        self.assertEqual(manifest['archive']['sha256'], hashlib.sha256(ARCHIVE).hexdigest())
        self.assertEqual((self.root / 'bucket' / manifest['archive']['key']).read_bytes(), ARCHIVE)
        local = next((self.config / 'archives').iterdir())
        self.assertEqual(local.stat().st_mode & 0o777, 0o700)
        self.assertEqual((local / 'projects.tar.gz').read_bytes(), ARCHIVE)

    def test_archive_requires_running_vm(self):
        self.vm(status='TERMINATED')
        result, calls = self.run_script('archive.sh')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'Start the VM with up.sh', result.stderr)
        self.assertEqual(calls, [])

    def test_failed_readback_never_publishes_pointer_or_stops_vm(self):
        self.env['MA_TEST_CORRUPT'] = '/projects.tar.gz'
        result, calls = self.run_script('archive.sh')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'R2 readback did not match', result.stderr)
        self.assertIn(b'Archive incomplete', result.stderr)
        self.assertFalse((self.root / 'bucket/latest.json').exists())
        self.assertNotIn('stop', [call.get('op') for call in calls])

    def test_restore_checks_archive_before_any_vm_change(self):
        self.put_archive(sha256='0' * 64)
        result, calls = self.run_script('restore.sh')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'Archive checksum mismatch', result.stderr)
        self.assertEqual([call for call in calls if call['tool'] == 'ssh'], [])

    def test_restore_streams_verified_archive(self):
        self.put_archive()
        result, calls = self.run_script('restore.sh')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        steps = [call['step'] for call in calls if call['tool'] == 'ssh']
        self.assertEqual(steps, [['empty'], ['stage', hashlib.sha256(ARCHIVE).hexdigest()], ['unpack'], ['deps']])
        stage = next(call for call in calls if call['tool'] == 'ssh' and call['step'][0] == 'stage')
        self.assertEqual(bytes.fromhex(stage['stdin']), ARCHIVE)
        self.assertIn(b'Restored 2 projects', result.stdout)

    def test_vm_only_teardown_snapshots_stopped_disk_before_deleting(self):
        self.put_archive(stamp='20261016T020000Z')
        self.vm(status='RUNNING')
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'VM is not stopped', result.stderr)
        self.assertEqual(calls, [])
        self.vm(status='TERMINATED', lastStart='2026-10-16T01:00:00Z')
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertNotIn(b'Warning', result.stderr)
        # Only the VM goes: no tunnel or DNS calls, and the snapshot precedes deletion.
        self.assertEqual(calls, [{'tool': 'gcloud', 'op': 'snapshot'}, {'tool': 'gcloud', 'op': 'delete'}])
        self.assertIn(b'up.sh --from-snapshot', result.stdout)

    def test_vm_only_teardown_keeps_vm_when_snapshot_fails(self):
        self.vm(status='TERMINATED', snapshotStatus='FAILED')
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'VM and disk were kept', result.stderr)
        self.assertEqual(calls, [{'tool': 'gcloud', 'op': 'snapshot'}])

    def test_vm_only_teardown_prunes_only_older_ready_owned_snapshots(self):
        self.vm(status='TERMINATED', snapshots=['oldest', 'foreign', 'previous'],
                snapshotLabels={'foreign': 'another-app'})
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(calls, [{'tool': 'gcloud', 'op': 'snapshot'}, {'tool': 'gcloud', 'op': 'delete'},
                                 {'tool': 'gcloud', 'op': 'prune', 'name': 'oldest'}])
        state = json.loads((self.root / 'vm.json').read_text())
        self.assertEqual(state['snapshots'][:2], ['foreign', 'previous'])
        self.assertEqual(len(state['snapshots']), 3)  # two owned READY copies plus foreign

    def test_vm_only_prune_waits_for_newer_incomplete_snapshot(self):
        self.vm(status='TERMINATED', snapshots=['oldest', 'previous', 'pending'],
                snapshotStatuses={'pending': 'UPLOADING'})
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual([call['op'] for call in calls], ['snapshot', 'delete'])

    def test_vm_only_prune_requires_deletion_readback(self):
        self.vm(status='TERMINATED', snapshots=['oldest', 'previous'])
        self.env['MA_TEST_PRUNE_STUCK'] = '1'
        result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'Snapshot deletion not confirmed', result.stderr)
        self.assertEqual(calls[-1], {'tool': 'gcloud', 'op': 'prune', 'name': 'oldest'})

    def test_vm_only_teardown_warns_when_data_archive_is_stale(self):
        self.vm(status='TERMINATED')
        result, calls = self.run_script('destroy.sh', '--vm-only')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'--confirm-destroy', result.stderr)
        for stamp in (None, '20261016T000000Z'):
            with self.subTest(archive=stamp):
                shutil.rmtree(self.root / 'bucket', ignore_errors=True)
                if stamp:
                    self.put_archive(stamp=stamp)
                self.vm(status='TERMINATED', lastStart='2026-10-16T01:00:00Z', deleted=False)
                result, calls = self.run_script('destroy.sh', '--vm-only', '--confirm-destroy')
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertIn(b'only the snapshot is current', result.stderr)
                self.assertEqual([call['op'] for call in calls], ['snapshot', 'delete'])

    def test_up_from_snapshot_recreates_only_a_retired_vm(self):
        self.vm(status='TERMINATED', snapshots=['min-atoms-vm-old', 'min-atoms-vm-new'])
        result, calls = self.run_script('up.sh', '--from-snapshot')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'VM already exists', result.stderr)
        self.assertEqual(calls, [])
        self.vm(deleted=True)
        result, calls = self.run_script('up.sh', '--from-snapshot')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(calls, [{'tool': 'gcloud', 'op': 'create', 'source': ['--source-snapshot=min-atoms-vm-new'],
                                  'metadata': ['--metadata=block-project-ssh-keys=true'],
                                  'sshKeys': 'tmars:ssh-rsa AAAATEST\n'}])
        self.vm(deleted=True, snapshots=[])
        result, calls = self.run_script('up.sh', '--from-snapshot')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'No ready min-atoms snapshot', result.stderr)
        self.assertEqual(calls, [])

    def test_fresh_vm_uses_spot_shape_and_keeps_ssh_metadata(self):
        self.vm(deleted=True)
        result, calls = self.run_script('up.sh', '--skip-health')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(calls, [{'tool': 'gcloud', 'op': 'create',
                                  'source': ['--image-family=debian-12', '--image-project=debian-cloud'],
                                  'metadata': ['--metadata=block-project-ssh-keys=true'],
                                  'sshKeys': 'tmars:ssh-rsa AAAATEST\n'}])

    def test_owned_vm_accepts_only_new_and_legacy_machine_types(self):
        for machine, expected in (('t2d-standard-2', 0), ('e2-standard-4', 0),
                                  ('e2-standard-2', 1), ('t2d-standard-4', 1)):
            with self.subTest(machine=machine):
                self.vm(machineType=machine)
                result = subprocess.run(['bash', '-c', 'source "$1/common.sh"; require_owned_vm',
                                         '_', str(self.root / 'infra/vm')],
                                        env=self.env, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, expected, result.stderr.decode())

    def test_freeze_fails_when_containers_cannot_be_listed(self):
        # The root guard is the only change; docker exits non-zero as on a broken daemon.
        script = (VM / 'archive-host.sh').read_text().replace("[[ $EUID == 0 ]] ||", "true ||", 1)
        host = self.root / 'archive-host.sh'
        host.write_text(script)
        bindir = self.root / 'host-bin'
        bindir.mkdir()
        for name, body in (('systemctl', 'exit 0'), ('docker', 'echo "$*" >> "$MA_TEST_ROOT/docker.log"; exit 42')):
            (bindir / name).write_text(f'#!/usr/bin/env bash\n{body}\n')
            (bindir / name).chmod(0o700)
        env = dict(self.env, PATH=f'{bindir}:{os.environ["PATH"]}')
        result = subprocess.run(['bash', str(host), 'freeze'], env=env, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Cannot list project containers', result.stderr)
        self.assertNotIn('stop', (self.root / 'docker.log').read_text())

    def test_dry_runs_make_no_calls(self):
        for name, args in (('archive.sh', ()), ('restore.sh', ()), ('restore.sh', ('--archive', '20261016T020000Z')),
                           ('destroy.sh', ('--vm-only',)), ('up.sh', ('--from-snapshot',))):
            with self.subTest(script=name, args=args):
                result, calls = self.run_script(name, '--dry-run', *args)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
