// 現場名リスト管理API
// GET  /api/sites  → 現場名配列を返す
// POST /api/sites  → { password, sites } で更新

const CONFIG_FILE_NAME = '_sites_config.json';
const BASE_FOLDER_NAME = 'ＫＹ・新規';
const CONFIG_FOLDER_NAME = '現場管理用設定ファイル（削除・編集禁止）';

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token_error: ' + JSON.stringify(data));
  return data.access_token;
}

async function findConfigFile(token, folderId) {
  // modifiedTime 降順で取得し、複数存在する場合は最新のものを返す
  const q = encodeURIComponent(
    `name='${CONFIG_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { files } = await res.json();
  return files && files.length > 0 ? files[0].id : null;
}

async function listAllConfigFileIds(token, folderId) {
  const q = encodeURIComponent(
    `name='${CONFIG_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { files } = await res.json();
  return files ? files.map(f => f.id) : [];
}

async function readConfigFile(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

async function getOrCreateFolder(token, name, parentId) {
  const q = encodeURIComponent(
    `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { files } = await searchRes.json();
  if (files && files.length > 0) return files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!createRes.ok) throw new Error(`folder_create_error(${createRes.status})`);
  const folder = await createRes.json();
  return folder.id;
}

async function writeConfigFileOnce(token, folderId, sites, targetFileId) {
  const content = JSON.stringify({ sites }, null, 2);
  const metadata = JSON.stringify(
    targetFileId ? {} : { name: CONFIG_FILE_NAME, parents: [folderId] }
  );
  const boundary = 'sites_boundary';
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    metadata,
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ].join('');

  const url = targetFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${targetFileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

  return fetch(url, {
    method: targetFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

async function writeConfigFile(token, folderId, sites, existingFileId) {
  // 既存ファイルへの更新(PATCH)は権限/参照切れで失敗することがあるため使わず、
  // 常に新規ファイルとして作成する。古いファイルは作成成功後に削除を試みる（失敗は無視）。
  const res = await writeConfigFileOnce(token, folderId, sites, null);
  if (!res.ok) throw new Error(`drive_write_error(${res.status}): ${await res.text()}`);
  const result = await res.json();

  const oldIds = (await listAllConfigFileIds(token, folderId)).filter(id => id !== result.id);
  await Promise.all(oldIds.map(id =>
    fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  ));

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const token = await getAccessToken();
      // GOOGLE_DRIVE_FOLDER_ID は参照先が壊れていたため使わず、
      // 「ＫＹ・新規」フォルダを名前で解決して使う（IDのズレが起きない）
      const baseFolder = await getOrCreateFolder(token, BASE_FOLDER_NAME, 'root');
      const configFolder = await getOrCreateFolder(token, CONFIG_FOLDER_NAME, baseFolder);
      const fileId = await findConfigFile(token, configFolder);
      if (!fileId) {
        // 設定ファイルが存在しない場合は空配列を返す（初期状態）
        return res.status(200).json({ sites: [] });
      }
      const config = await readConfigFile(token, fileId);
      return res.status(200).json({ sites: config.sites || [] });
    }

    if (req.method === 'POST') {
      const { password, sites } = req.body;
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'パスワードが正しくありません' });
      }
      if (!Array.isArray(sites)) {
        return res.status(400).json({ error: '現場名リストが不正です' });
      }
      const token = await getAccessToken();
      const baseFolder = await getOrCreateFolder(token, BASE_FOLDER_NAME, 'root');
      const configFolder = await getOrCreateFolder(token, CONFIG_FOLDER_NAME, baseFolder);
      const existingFileId = await findConfigFile(token, configFolder);

      // 既存の現場名を取得（保存件数カウント用）
      let existingSites = [];
      if (existingFileId) {
        const config = await readConfigFile(token, existingFileId);
        existingSites = config.sites || [];
      }
      const newSites = sites.filter(s => !existingSites.includes(s));

      // 全現場名を対象にフォルダの有無を確認・補完する（getOrCreateFolderは既存なら作り直さない）
      for (const site of sites) {
        // 現場名フォルダは「ＫＹ・新規」フォルダの直下に作成
        const siteFolder = await getOrCreateFolder(token, site.slice(0, 50), baseFolder);
        await getOrCreateFolder(token, 'KY記録', siteFolder);
        await getOrCreateFolder(token, '新規入場者アンケート', siteFolder);
      }

      await writeConfigFile(token, configFolder, sites, existingFileId);
      return res.status(200).json({ success: true, count: sites.length, foldersCreated: newSites.length });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (err) {
    console.error('sites api error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
