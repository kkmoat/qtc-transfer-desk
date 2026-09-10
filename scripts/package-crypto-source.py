"""Package corresponding crypto source deterministically, without generated or private files.
Run from the repository root after reviewing and rebuilding the public crypto assets.
"""
from pathlib import Path
import hashlib
import re
import zipfile

source = Path('crypto')
files = [source / name for name in ('Cargo.toml', 'Cargo.lock', 'README.md', 'REBUILD.md', 'LICENSE', 'test-node.cjs', 'build.sh', 'cargo-vendor-config.toml')]
files += [path for folder in ('src', 'vendor') for path in (source / folder).rglob('*') if path.is_file()]
archive = Path('public/source/quantus-browser-crypto-source.zip')
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in sorted(files):
        info = zipfile.ZipInfo('quantus-browser-crypto-source/' + path.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if path.name == 'build.sh' else 0o100644) << 16
        output.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
paths = [Path('public/crypto') / name for name in ('quantus_browser_crypto.d.ts', 'quantus_browser_crypto.js', 'quantus_browser_crypto_bg.wasm', 'worker.js')] + [archive]
hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
Path('public/source/crypto-SHA256SUMS.txt').write_text('# From repository root: shasum -a 256 -c public/source/crypto-SHA256SUMS.txt\n' + ''.join(f'{digest}  {path}\n' for path, digest in hashes.items()))
pins = '\n'.join(f"  '{path.removeprefix('public/')}': '{digest}'," for path, digest in hashes.items())
verifier = Path('scripts/verify-crypto.mjs')
verifier.write_text(re.sub(r'export const CRYPTO_PINS = \{.*?\n\};', 'export const CRYPTO_PINS = {\n' + pins + '\n};', verifier.read_text(), count=1, flags=re.S))
print(f'Packaged {len(files)} corresponding source files and updated reviewed asset checksums.')
