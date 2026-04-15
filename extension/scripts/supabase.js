// Lightweight Supabase client for Chrome Extension (no SDK needed)
import { getConfig } from './config.js';

class SupabaseClient {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  }

  async query(table, { select = '*', filters = {}, schema = 'upwork', limit, order } = {}) {
    let url = `${this.url}/rest/v1/${table}?select=${select}`;
    
    for (const [key, value] of Object.entries(filters)) {
      url += `&${key}=eq.${encodeURIComponent(value)}`;
    }
    if (limit) url += `&limit=${limit}`;
    if (order) url += `&order=${order}`;

    const res = await fetch(url, {
      headers: { ...this.headers, 'Accept-Profile': schema }
    });
    if (!res.ok) throw new Error(`Supabase query error: ${res.status}`);
    return res.json();
  }

  async insert(table, data, schema = 'upwork') {
    const url = `${this.url}/rest/v1/${table}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Profile': schema, 'Accept-Profile': schema },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase insert error: ${res.status} ${errText}`);
    }
    return res.json();
  }

  async upsert(table, data, schema = 'upwork', onConflict = 'id') {
    const url = `${this.url}/rest/v1/${table}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Profile': schema,
        'Accept-Profile': schema,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Supabase upsert error: ${res.status}`);
    return res.json();
  }

  async update(table, data, filters = {}, schema = 'upwork') {
    let url = `${this.url}/rest/v1/${table}?`;
    for (const [key, value] of Object.entries(filters)) {
      url += `${key}=eq.${encodeURIComponent(value)}&`;
    }
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...this.headers, 'Content-Profile': schema, 'Accept-Profile': schema },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Supabase update error: ${res.status}`);
    return res.json();
  }

  async rpc(fnName, params = {}, schema = 'upwork') {
    const url = `${this.url}/rest/v1/rpc/${fnName}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Profile': schema, 'Accept-Profile': schema },
      body: JSON.stringify(params)
    });
    if (!res.ok) throw new Error(`Supabase RPC error: ${res.status}`);
    return res.json();
  }
}

let clientInstance = null;

export async function getSupabase() {
  if (clientInstance) return clientInstance;
  const config = await getConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Supabase not configured. Open extension popup to set keys.');
  }
  clientInstance = new SupabaseClient(config.supabaseUrl, config.supabaseAnonKey);
  return clientInstance;
}

// Reset client (e.g. after config change)
export function resetSupabase() {
  clientInstance = null;
}
