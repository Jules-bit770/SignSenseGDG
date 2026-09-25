"""Start SignSense with a Python environment containing the recognition packages.

Run with any Python: python start_letters.py
Set SIGNSENSE_PYTHON to explicitly choose an interpreter.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGES = ('numpy', 'tensorflow', 'mediapipe', 'cv2', 'PIL')


def candidates(root):
    explicit = os.environ.get('SIGNSENSE_PYTHON')
    if explicit:
        return [Path(explicit)]
    model = Path(os.environ.get('SIGNSENSE_MODEL_REPO', root.parent / 'Modeltraining'))
    paths = [Path(sys.executable)]
    for location in (root, model):
        paths.extend([location / '.venv/Scripts/python.exe', location / '.venv/bin/python'])
    for home in (root.parent, Path.home()):
        paths.extend(home / distribution / 'python.exe' for distribution in ('miniconda3', 'anaconda3'))
        paths.extend(home / distribution / 'bin/python' for distribution in ('miniconda3', 'anaconda3'))
    found = shutil.which('python')
    if found:
        paths.append(Path(found))
    return list(dict.fromkeys(paths))


def choose_python(root):
    probe = ('import importlib.util,sys; '
             f'sys.exit(0 if all(importlib.util.find_spec(n) is not None for n in {PACKAGES!r}) else 1)')
    for path in candidates(root):
        if not path.is_file():
            continue
        try:
            checked = subprocess.run([str(path), '-c', probe], capture_output=True, timeout=15)
            if checked.returncode == 0:
                return path
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise RuntimeError('No Python environment has all recognition packages. Install the Modeltraining '
                       'requirements.txt in your chosen environment, then set SIGNSENSE_PYTHON '
                       'to its python executable and run this launcher again.')


def main():
    root = Path(__file__).resolve().parent
    try:
        interpreter = choose_python(root)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f'SignSense recognition Python: {interpreter}', flush=True)
    try:
        return subprocess.call([str(interpreter), '-u', str(root / 'serve.py')])
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
