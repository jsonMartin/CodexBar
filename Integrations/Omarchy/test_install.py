import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class InstallTests(unittest.TestCase):
    def test_migration_and_reinstall_preserve_preferences_and_layout(self):
        with tempfile.TemporaryDirectory(prefix='codexbar install ') as temporary:
            home = Path(temporary)
            config = home / 'config'
            shell = config / 'omarchy/shell.json'
            shell.parent.mkdir(parents=True)
            shell.write_text(json.dumps({'bar': {'layout': {'right': [
                {'id': 'steipete.codexbar', 'provider': 'claude', 'refreshSeconds': 900, 'allAccounts': True},
                {'id': 'omarchy.clock'}]}}, 'idle': {'lock': 123}}))
            script = Path(__file__).with_name('install.py')
            environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(config), XDG_DATA_HOME=str(home/'data'))
            for _ in range(2):
                subprocess.run(['python3', str(script), '--executable', '/usr/bin/true',
                                '--desktop-binary', '/usr/bin/true'], env=environment, check=True, capture_output=True)
            result = json.loads(shell.read_text())
            self.assertEqual(result['idle'], {'lock': 123})
            self.assertEqual([e['id'] for e in result['bar']['layout']['right']], ['steipete.codexbar', 'omarchy.clock'])
            entry = result['bar']['layout']['right'][0]
            self.assertEqual(set(entry), {'id', 'desktopExecutable'})
            settings = json.loads((config/'codexbar/linux.json').read_text())
            self.assertEqual(settings['provider'], 'claude')
            self.assertEqual(settings['refreshSeconds'], 900)
            self.assertTrue(settings['allAccounts'])
            self.assertFalse(settings['showTray'])
            self.assertEqual(len(list((shell.parent / 'plugins').glob('*/manifest.json'))), 1)
            self.assertEqual(len(list((shell.parent / 'backups').iterdir())), 1)
            self.assertEqual((config/'codexbar/linux.json').stat().st_mode & 0o077, 0)
            launcher = (home/'data/applications/com.steipete.CodexBar.desktop').read_text()
            self.assertIn(f'Exec="{home}/.local/bin/codexbar-linux" --settings', launcher)
            self.assertTrue((config/'autostart/com.steipete.CodexBar.desktop').exists())

    def test_dotfiles_symlinks_survive_and_receive_the_change(self):
        with tempfile.TemporaryDirectory(prefix='codexbar symlink ') as temporary:
            home = Path(temporary)
            config, data = home / 'config', home / 'data'
            managed = home / 'dotfiles'
            (managed / 'omarchy').mkdir(parents=True)
            (managed / 'codexbar').mkdir()
            (managed / 'autostart').mkdir()
            tracked = managed / 'omarchy/shell.json'
            tracked.write_text(json.dumps({'bar': {'layout': {'right': [
                {'id': 'omarchy.clock', 'format': "'\uf017  'HH:mm"}]}}}, ensure_ascii=False))
            (config / 'omarchy').mkdir(parents=True)
            (config / 'omarchy/shell.json').symlink_to(tracked)
            # A preferences link can predate the install; an autostart link is created by it.
            (config / 'codexbar').mkdir()
            preferences = managed / 'codexbar/linux.json'
            preferences.write_text(json.dumps({'provider': 'claude'}))
            (config / 'codexbar/linux.json').symlink_to(preferences)
            (config / 'autostart').mkdir()
            startup = managed / 'autostart/com.steipete.CodexBar.desktop'
            startup.write_text('[Desktop Entry]\n')
            (config / 'autostart/com.steipete.CodexBar.desktop').symlink_to(startup)
            script = Path(__file__).resolve().parents[1] / 'Linux/install.py'
            environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(config), XDG_DATA_HOME=str(data))
            subprocess.run(['python3', str(script), '--binary', '/usr/bin/true', '--cli', '/usr/bin/true',
                            '--omarchy'], env=environment, check=True, capture_output=True)
            for link in ['omarchy/shell.json', 'codexbar/linux.json', 'autostart/com.steipete.CodexBar.desktop']:
                self.assertTrue((config / link).is_symlink(), f'{link} lost its link')
            self.assertIn('steipete.codexbar',
                          [entry['id'] for entry in json.loads(tracked.read_text())['bar']['layout']['right']])
            self.assertEqual(json.loads(preferences.read_text())['provider'], 'claude')
            self.assertIn('--background', startup.read_text())
            # Rewriting a managed file must not turn its glyphs into escapes and churn the diff.
            self.assertIn('\uf017', tracked.read_text())
            self.assertNotIn('\\uf017', tracked.read_text())
            # The installer's own payload still replaces whatever occupies its path.
            self.assertFalse((home / '.local/bin/codexbar-linux').is_symlink())

    def test_standalone_install_does_not_require_omarchy(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'config'), XDG_DATA_HOME=str(home/'data'))
            script = Path(__file__).resolve().parents[1] / 'Linux/install.py'
            subprocess.run(['python3', str(script), '--binary', '/usr/bin/true', '--cli', '/usr/bin/true', '--no-autostart'],
                           env=environment, check=True, capture_output=True)
            self.assertFalse((home/'config/omarchy').exists())
            self.assertIn('Hidden=true', (home/'config/autostart/com.steipete.CodexBar.desktop').read_text())


if __name__ == '__main__':
    unittest.main()
