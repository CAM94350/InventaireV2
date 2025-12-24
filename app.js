
function setLockStatus(msg, ok=false){
  const el = document.getElementById('lock-status');
  if(!el) return;
  el.textContent = msg || '';
  el.className = ok ? 'lock-status ok' : 'lock-status';
}

function setUiReadOnly(readonly, reason=''){
  isReadOnly = readonly;
  const ids = ['add-row','save','btn-take-photo'];
  ids.forEach(id=>{
    const b = document.getElementById(id);
    if(b) b.disabled = readonly;
  });
  const loc = document.getElementById('palette-location');
  if(loc) loc.disabled = readonly;

  // disable table inputs
  document.querySelectorAll('#inventory-table input').forEach(inp=>{
    inp.disabled = readonly;
  });

  if(readonly){
    setLockStatus(reason || "Palette verrouillée : un autre utilisateur est en train d’inventorier.", false);
  }else{
    setLockStatus("", true);
  }
}

async function acquireLock(paletteId){
  // stop previous renew
  if(lockRenewTimer){ clearInterval(lockRenewTimer); lockRenewTimer = null; }
  currentLockToken = null;

  const { data, error } = await supabase.rpc('acquire_palette_lock_v2', {
      p_session_id: getClientSessionId(),
    p_palette_id: paletteId,
    p_ttl_seconds: 600
  });

  if(error){
    // If server raised PALETTE_LOCKED, show readonly; otherwise show technical error
    const msg = (error.message || '').toLowerCase();
    if(msg.includes('palette_locked') || msg.includes('palette locked') || error.code === 'P0001'){
      setUiReadOnly(true, "Palette verrouillée : un autre utilisateur est en train d’inventorier.");
      return false;
    }
    alert(`Erreur lock (acquire_palette_lock_v2): ${error.message}`);
    setUiReadOnly(true, "Erreur technique lors de la prise de verrou.");
    return false;
  }

  // data can be array or object depending on supabase-js
  const row = Array.isArray(data) ? data[0] : data;
  currentLockToken = row?.lock_token || row?.lock_token || row?.lock_token;
  setUiReadOnly(false, "");
  lockRenewTimer = setInterval(async ()=>{
    try{
      await supabase.rpc('acquire_palette_lock_v2', {
      p_session_id: getClientSessionId(), p_palette_id: paletteId, p_ttl_seconds: 600 });
    }catch(e){ console.error(e); }
  }, 60000);
  return true;
}

async function releaseLock(){
  if(lockRenewTimer){ clearInterval(lockRenewTimer); lockRenewTimer = null; }
  if(!currentPaletteId || !currentLockToken) return;
  try{
    await supabase.rpc('release_palette_lock_v2', {
      p_session_id: getClientSessionId(), p_palette_id: currentPaletteId, p_lock_token: currentLockToken });
  }catch(e){ console.error(e); }
  currentLockToken = null;
}

const VERSION = "v11.3";
document.title = `Inventaire — ${VERSION}`;

const SUPABASE_URL = "https://cypxkiqaemuclcbdtgtw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cHhraXFhZW11Y2xjYmR0Z3R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0MTY3MzksImV4cCI6MjA4MTk5MjczOX0.rHSZBiz68osvqPvpoDhVFGu8l5-j7CVpB5mEVSxRG9Y";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);



// v11.3 – client session id (per browser/device). Ensures locks work even with same login on multiple devices.
function getClientSessionId() {
  const key = 'inventaire_session_id';
  let v = localStorage.getItem(key);
  if (!v) {
    v = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
    localStorage.setItem(key, v);
  }
  return v;
}

const $ = (sel, root=document)=>root.querySelector(sel);
const $all = (sel, root=document)=>Array.from(root.querySelectorAll(sel));
let currentPaletteId = null;
let currentLockToken = null;
let lockRenewTimer = null;
let isReadOnly = false; let isAuthenticated = false; let lastLoadedCode = '';

function newRow(){ return $('#row-template').content.firstElementChild.cloneNode(true); }
function serializeRow(tr){
  return {
    id: tr.dataset.rowId || null,
    designation: tr.querySelector('.designation').value.trim(),
    qty: Math.max(0, Number(tr.querySelector('.qty').value || 0))
  };
}

function fillTable(lines) {
  const tbody = $('#table-body');
  tbody.innerHTML = '';
  (lines ?? [])
    .sort((a, b) => (a.designation ?? '').localeCompare(b.designation ?? '', 'fr', { sensitivity: 'base' }))
    .forEach(line => {
      const tr = newRow();
      tr.querySelector('.designation').value = line.designation ?? '';
      tr.querySelector('.qty').value = Math.max(0, Number(line.qty ?? 0));
      tr.dataset.rowId = line.id ?? '';
      tbody.appendChild(tr);
    });
}

function setStatus(msg){ $('#status').textContent = msg; }

// --- AUTH ---
async function signIn(email, password){
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if(error) throw error; return data.user;
}
async function signOut(){ await supabase.auth.signOut(); }

const authFormEl = () => document.getElementById('auth-form');
const authInfoEl = () => document.getElementById('auth-info');
const authUserEl = () => document.getElementById('auth-user');

function refreshAuthUI(session){
  const isAuth = !!(session?.user);
  document.body.classList.toggle('is-authenticated', isAuth);
  if (isAuth) {
    if (authFormEl()) authFormEl().hidden = true;
    if (authInfoEl()) authInfoEl().hidden = false;
    if (authUserEl()) authUserEl().textContent = session.user.email || '';
    isAuthenticated = true;
  } else {
    if (authFormEl()) authFormEl().hidden = false;
    if (authInfoEl()) authInfoEl().hidden = true;
    if (authUserEl()) authUserEl().textContent = '';
    isAuthenticated = false;
  }
}

function bindAuthHandlers(){
  document.getElementById('auth-form')?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    try {
      const email = document.getElementById('auth-email').value.trim();
      const pwd   = document.getElementById('auth-password').value;
      await signIn(email, pwd);
    } catch(err){ alert('Auth: '+err.message); }
  });
  document.getElementById('btn-logout')?.addEventListener('click', async ()=>{ await signOut(); });
}

async function initAuthUI(){
  const { data: { session } } = await supabase.auth.getSession();
  refreshAuthUI(session);
  supabase.auth.onAuthStateChange((_event, newSession) => refreshAuthUI(newSession));
}

// DATA
async function getOrCreatePaletteByCode(code){
  let { data: pal, error } = await supabase
    .from('palettes').select('id, code, location').eq('code', code).maybeSingle();
  if(error) throw error;
  if(pal) return pal;

  const location = ($('#palette-location')?.value || '').trim() || null;
  const { data: created, error: e2 } = await supabase
    .from('palettes').insert({ code, location }).select('id, code, location').single();
  if(e2) throw e2;
  return created;
}

async function ensureItemAndGetId(designation){
  const name = (designation||'').trim();
  if(!name) return null;
  if(!isAuthenticated) return null; // RLS

  // 1) Upsert + retour id
  const { data: upserted, error: e1 } = await supabase
    .from('items')
    .upsert({ designation: name }, { onConflict: 'designation' })
    .select('id, designation')
    .maybeSingle();
  if(e1) {
    console.warn('items upsert error:', e1.message);
  }
  if(upserted?.id) return upserted.id;

  // 2) Fallback: select
  const { data: selected, error: e2 } = await supabase
    .from('items')
    .select('id')
    .eq('designation', name)
    .maybeSingle();
  if(e2) {
    console.warn('items select error:', e2.message);
    return null;
  }
  return selected?.id ?? null;
}

async function prefillFromItemsIfEmpty(paletteId){
  const { count } = await supabase
    .from('pallet_items').select('id', { count:'exact', head:true })
    .eq('palette_id', paletteId);
  if((count||0) > 0) return;
  const { data: items } = await supabase.from('items').select('id, designation');
  if(!items?.length) return;
  const rows = items.map(it=>({ palette_id: paletteId, designation: (it.designation||''), qty: 0 }));
  await supabase.from('pallet_items').insert(rows);
}

async function loadPaletteByCode(code){
  if(!code){ alert('Saisir un numéro de palette'); return; }
  setStatus('Chargement...');

  const pal = await getOrCreatePaletteByCode(code);
  currentPaletteId = pal.id;
  lastLoadedCode = code;

  // v11.3: acquire lock
  await acquireLock(currentPaletteId);
  // v11.3: load photos
  await renderPalettePhotos(currentPaletteId);


  // Localisation : si vide sur la palette chargée, on vide le champ de saisie
  const locInput = $('#palette-location');
  if(locInput) locInput.value = (pal.location || '').trim();

  await prefillFromItemsIfEmpty(pal.id);

  const { data: lines, error } = await supabase
    .from('pallet_items')
    .select('id, designation, qty')
    .eq('palette_id', pal.id)
    .order('updated_at', { ascending:false });
  if(error) throw error;

  fillTable(lines||[]);
  setStatus(`Palette ${code} chargée (${lines?.length||0} lignes)`);
}

async function saveCurrentPalette(){
  const code = $('#palette-code').value.trim(); if(!code){ alert('Aucune palette'); return; }
  const paletteId = currentPaletteId || await getOrCreatePaletteByCode(code);
  currentPaletteId = paletteId;
  const trs = $all('#table-body tr'); if(trs.length===0){ setStatus('Rien à sauvegarder'); return; }
  // On ignore les lignes vides (sinon contrainte NOT NULL côté DB)
  const rows = trs.map(serializeRow).filter(r => !!r.designation);
  if(rows.length === 0){ setStatus('Rien à sauvegarder'); return; }

  // Pour éviter l'erreur "id = null", on force un UUID côté client si besoin.
  // (plus robuste que de compter sur le DEFAULT DB lors d'un upsert)
  for(const tr of trs){
    if(!tr.dataset.rowId){
      tr.dataset.rowId = (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    }
  }

  const payload = rows.map(r=>({
    id: r.id || (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    palette_id: paletteId,
    designation: r.designation,
    qty: Math.max(0, r.qty),
    updated_at: new Date().toISOString()
  }));
  const { data, error } = await supabase
    .from('pallet_items')
    .upsert(payload, { onConflict:'id' }).select('id');
  if(error){ alert(error.message); return; }
																														   

  const unique = Array.from(new Set(rows.map(r=>r.designation.trim()).filter(Boolean)));
  if(isAuthenticated && unique.length){
    const upserts = unique.map(d => ({ designation: d }));
    const { error: e2 } = await supabase.from('items').upsert(upserts, { onConflict: 'designation' });
    if(e2) console.warn('items bulk upsert error:', e2.message);
  }

  setStatus(`Sauvegardé (${payload.length} lignes)`);
}

function exportCSV(){
  const rows = $all('#table-body tr').map(serializeRow);
  const header = ['Designation','Qty'];
  const lines = [header.join(';')].concat(
    rows.map(r => [r.designation, Math.max(0, r.qty)].map(v => String(v).replace(/;/g, ',')).join(';'))
  );
  const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href=url; a.download='inventaire.csv'; a.click(); URL.revokeObjectURL(url);
}

function addRow(){
  const tr = newRow();
  // On attribue immédiatement un UUID pour que les futures sauvegardes n'envoient jamais id=null
  tr.dataset.rowId = (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  $('#table-body').appendChild(tr);

  // Mobile/desktop: on se positionne en bas du tableau et focus sur la désignation
  requestAnimationFrame(() => {
    tr.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const input = tr.querySelector('.designation');
    input?.focus();
    input?.select?.();
  });
}

function handleQtyButtons(e){
  const btn = e.target.closest('.qty-btn'); if(!btn) return;
  const tr = e.target.closest('tr'); if(!tr) return;
  const input = tr.querySelector('.qty'); if(!input) return;
  const val = Math.max(0, Number(input.value || 0));
  const step = Number(input.step || 1) || 1;
  if(btn.classList.contains('qty-plus')) input.value = val + step;
  else if(btn.classList.contains('qty-minus')) input.value = Math.max(0, val - step);
}

function handleQtyKey(e){
  const input = e.target.closest('.qty'); if(!input) return;
  if(e.key === 'ArrowUp'){ e.preventDefault(); input.value = Math.max(0, Number(input.value||0)) + 1; }
  if(e.key === 'ArrowDown'){ e.preventDefault(); input.value = Math.max(0, Number(input.value||0) - 1); }
}

function focusQtyOnDesignationClick(e){
  const input = e.target.closest('.designation'); if(!input) return;
  const tr = input.closest('tr'); const qty = tr?.querySelector('.qty');
  if(!qty) return; const text = input.value.trim();
  if(text.length > 0){ qty.focus(); qty.select?.(); }
}

async function handleDesignationBlur(e){
  const input = e.target.closest('.designation');
  if(!input) return;
  const tr = input.closest('tr');
  const text = input.value.trim();
  if(!text) return;

  // À la sortie du champ : insertion/upsert dans items + récupération de l'id
  const itemId = await ensureItemAndGetId(text);
  if(itemId && tr) tr.dataset.itemId = itemId;
}

function bindUI(){
  $('#btn-load-palette').addEventListener('click', ()=>loadPaletteByCode($('#palette-code').value.trim()));
  $('#add-row').addEventListener('click', addRow);
  $('#save').addEventListener('click', saveCurrentPalette);
  $('#export-csv').addEventListener('click', exportCSV);
  $('#print').addEventListener('click', ()=>window.print());
  $('#table-body').addEventListener('click', handleQtyButtons);
  $('#table-body').addEventListener('keydown', handleQtyKey);
  $('#table-body').addEventListener('click', focusQtyOnDesignationClick);
  // focusout (capture) fonctionne mieux que blur sur délégation d'événements
  $('#table-body').addEventListener('focusout', handleDesignationBlur, true);
}

async function main(){
  bindUI();
  bindAuthHandlers();
  await initAuthUI();
  const h1 = document.querySelector('h1'); if(h1) h1.textContent = `Inventaire — ${VERSION}`;
}

main();


async function getSignedPhotoUrl(objectPath, expiresIn = 3600) {
  const { data, error } = await supabase.storage.from('palette-photos').createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function renderPalettePhotos(paletteId) {
  const container = document.getElementById('palette-photos');
  if (!container) return;
  container.innerHTML = '';
  if (!paletteId) return;

  const { data: photos, error } = await supabase
    .from('palette_photos')
    .select('id, path, created_at')
    .eq('palette_id', paletteId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Erreur chargement photos', error);
    return;
  }

  for (const p of (photos || [])) {
    try {
      const url = await getSignedPhotoUrl(p.path, 3600);
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Photo palette';
      img.className = 'palette-photo-thumb';
      img.loading = 'lazy';
      container.appendChild(img);
    } catch (e) {
      console.error('Erreur URL signée', e);
    }
  }
}

async function uploadPalettePhoto(file) {
  if (!currentPaletteId || !file) return;
  if (isReadOnly) return;

  const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const objectPath = `palette_${currentPaletteId}/${ts}.${ext}`;

  // Upload in private bucket
  const { error: upErr } = await supabase.storage
    .from('palette-photos')
    .upload(objectPath, file, { upsert: false, contentType: file.type || 'image/jpeg' });

  if (upErr) throw upErr;

  // Persist reference (requires lock via RLS)
  const { error: insErr } = await supabase
    .from('palette_photos')
    .insert({ palette_id: currentPaletteId, path: objectPath });

  if (insErr) throw insErr;

  await renderPalettePhotos(currentPaletteId);
}


window.addEventListener('beforeunload', ()=>{ try{ releaseLock(); }catch(e){} });
