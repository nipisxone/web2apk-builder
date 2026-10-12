// .github/scripts/upload_mediafire.js
// Upload APK hasil build ke MediaFire dari dalam job GitHub Actions. Tanpa dependency (Node 18+).
// Env:
//   MEDIAFIRE_SESSION_TOKEN  (wajib, dari GitHub Secrets)
//   APK_SEARCH_DIR           (opsional, default '.')
// Output log: MEDIAFIRE_URL=https://www.mediafire.com/file/<quickkey>
// Script TIDAK pernah bikin job gagal: kalau upload error, cuma tulis MEDIAFIRE_ERROR=...
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.MEDIAFIRE_API || 'https://www.mediafire.com/api/1.4';
const TOKEN = process.env.MEDIAFIRE_SESSION_TOKEN || '';
const SEARCH_DIR = process.env.APK_SEARCH_DIR || '.';
const SIMPLE_MAX = 20 * 1024 * 1024;
const UNIT_RETRY = 3;
const POLL_INTERVAL = 3000;
const POLL_MAX = 600;
const SKIP_DIRS = new Set(['node_modules', '.git']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeName(n) { return String(n || 'app.apk').replace(/[^A-Za-z0-9._-]/g, '_'); }

function findApks(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) findApks(p, out); }
        else if (e.isFile() && e.name.toLowerCase().endsWith('.apk')) out.push(p);
    }
    return out;
}
// Aturan pilih file sama dengan bot: utamakan yang bukan arm/x86
function pickApk(files) { return files.find(f => !/arm|x86/i.test(path.basename(f))) || files[0]; }

function sha256Stream(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}
function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readRange(fd, buf, offset) {
    let read = 0;
    while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, offset + read);
        if (n === 0) throw new Error('baca file berhenti di offset ' + (offset + read));
        read += n;
    }
}

// Respons MediaFire JSON dibungkus di "response"
async function mfCall(method, action, query = {}, body = undefined, headers = {}) {
    const qs = new URLSearchParams({ ...query, session_token: TOKEN, response_format: 'json' });
    const res = await fetch(API + '/' + action + '.php?' + qs.toString(), { method, headers, body });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(action + ': respons bukan JSON (HTTP ' + res.status + ')'); }
    const r = data.response || data;
    if (r.result !== 'Success') throw new Error(action + ': ' + (r.message || r.error || r.result || ('HTTP ' + res.status)));
    return r;
}

async function pollUpload(key) {
    for (let i = 0; i < POLL_MAX; i++) {
        const r = await mfCall('GET', 'upload/poll_upload', { key });
        const d = r.doupload || (Array.isArray(r.douploads) && r.douploads[0]) || {};
        if (d.fileerror) throw new Error('fileerror MediaFire ' + d.fileerror);
        if (String(d.status) === '99' && d.quickkey) return d.quickkey;
        await sleep(POLL_INTERVAL);
    }
    throw new Error('timeout nunggu MediaFire memproses file');
}

async function uploadSimple(file, name, size, fileHash) {
    const buf = fs.readFileSync(file);
    const r = await mfCall('POST', 'upload/simple', {}, buf, {
        'Content-Type': 'application/octet-stream',
        'x-filename': name,
        'x-filesize': String(size),
        'x-filehash': fileHash
    });
    const d = r.doupload || {};
    if (!d.key) throw new Error('upload/simple tidak mengembalikan key');
    return pollUpload(d.key);
}

async function uploadResumable(file, name, size, fileHash) {
    const chk = await mfCall('GET', 'upload/check', { filename: name, size, hash: fileHash, resumable: 'yes' });
    const ru = chk.resumable_upload;
    if (!ru) {
        if (chk.hash_exists === 'yes') {
            const inst = await mfCall('POST', 'upload/instant', { filename: name, size, hash: fileHash });
            if (inst.quickkey) return inst.quickkey;
        }
        throw new Error('upload/check tidak mengembalikan resumable_upload');
    }
    const unitSize = Number(ru.unit_size), units = Number(ru.number_of_units);
    if (!unitSize || !units) throw new Error('unit_size / number_of_units tidak valid');
    const fd = fs.openSync(file, 'r');
    try {
        let key = null, last = null;
        for (let id = 0; id < units; id++) {
            const offset = id * unitSize;
            const len = Math.min(unitSize, size - offset);
            const chunk = Buffer.alloc(len);
            readRange(fd, chunk, offset);
            const unitHash = sha256Buf(chunk);
            let ok = false, lastErr = null;
            for (let a = 1; a <= UNIT_RETRY && !ok; a++) {
                try {
                    last = await mfCall('POST', 'upload/resumable', {}, chunk, {
                        'Content-Type': 'application/octet-stream',
                        'x-filename': name,
                        'x-filesize': String(size),
                        'x-filehash': fileHash,
                        'x-unit-hash': unitHash,
                        'x-unit-id': String(id),
                        'x-unit-size': String(len)
                    });
                    key = (last.doupload && last.doupload.key) || key;
                    ok = true;
                } catch (e) { lastErr = e; await sleep(1500 * a); }
            }
            if (!ok) throw new Error('unit ' + id + ' gagal: ' + (lastErr ? lastErr.message : '?'));
        }
        const ready = last && last.resumable_upload && last.resumable_upload.all_units_ready;
        if (ready !== 'yes') throw new Error('MediaFire belum menerima semua unit (all_units_ready=' + ready + ')');
        if (!key) throw new Error('key upload tidak ditemukan');
        return pollUpload(key);
    } finally { fs.closeSync(fd); }
}

(async () => {
    try {
        if (!TOKEN) throw new Error('MEDIAFIRE_SESSION_TOKEN kosong (cek GitHub Secrets)');
        const apks = findApks(SEARCH_DIR);
        if (!apks.length) throw new Error('tidak ada file .apk di ' + SEARCH_DIR);
        const file = pickApk(apks);
        const name = safeName(path.basename(file));
        const size = fs.statSync(file).size;
        const fileHash = await sha256Stream(file);
        console.log('MEDIAFIRE_FILE=' + name + ' (' + size + ' bytes)');
        const qk = size <= SIMPLE_MAX
            ? await uploadSimple(file, name, size, fileHash)
            : await uploadResumable(file, name, size, fileHash);
        console.log('MEDIAFIRE_URL=https://www.mediafire.com/file/' + qk);
    } catch (e) {
        console.log('MEDIAFIRE_ERROR=' + e.message);
        console.log('::warning::Upload MediaFire gagal: ' + e.message);
    }
})();
