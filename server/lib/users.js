import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './waiflo-data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let usersWriteQueue = Promise.resolve();

async function ensureUsersFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(USERS_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

export async function readUsers() {
  await ensureUsersFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(raw);
}

export async function writeUsers(users) {
  await ensureUsersFile();
  const tmp = `${USERS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(users, null, 2), 'utf8');
  await fs.rename(tmp, USERS_FILE);
}

async function withUsersWriteLock(task) {
  const run = usersWriteQueue.then(task);
  usersWriteQueue = run.catch(() => {});
  return run;
}

export async function getUser(userId) {
  const users = await readUsers();
  return users[userId] || null;
}

export async function saveUser(userId, data) {
  return withUsersWriteLock(async () => {
    const users = await readUsers();
    users[userId] = { ...(users[userId] || {}), ...data };
    await writeUsers(users);
    return users[userId];
  });
}

export async function userExists(email) {
  const users = await readUsers();
  return Object.values(users).some(u => u && u.email === email);
}

export async function findByEmail(email) {
  const users = await readUsers();
  const entry = Object.entries(users).find(([, u]) => u && u.email === email);
  return entry ? { userId: entry[0], ...entry[1] } : null;
}

export async function ensureUserDir(userId) {
  const dir = path.join(DATA_DIR, 'workflows', userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function workflowDir(userId) {
  return path.join(DATA_DIR, 'workflows', userId);
}
