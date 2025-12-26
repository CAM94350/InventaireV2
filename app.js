let isPickingPhoto = false;
let currentPaletteNumber = null;
document.addEventListener('DOMContentLoaded', () => {
  try { setupLocationAutosave(); } catch(e) { console.error(e); } try { setupPhotoCapture(); setupPaletteNumberSync(); } catch(e) { console.error(e); } });


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

const VERSION = "v12.5";
document.title = `Inventaire — ${VERSION}`;

const SUPABASE_URL = "https://cypxkiqaemuclcbdtgtw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cHhraXFhZW11Y2xjYmR0Z3R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0MTY3MzksImV4cCI6MjA4MTk5MjczOX0.rHSZBiz68osvqPvpoDhVFGu8l5-j7CVpB5mEVSxRG9Y";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// v12.5 – Audit (parcours utilisateur)
async function logEvent(action, opts = {}) {
  try {
    await supabase.rpc('log_event', {
      p_action: action,
      p_entity_type: opts.entity_type ?? null,
      p_entity_id: opts.entity_id ?? null,
      p_palette_id: opts.palette_id ?? null,
      p_palette_code: opts.palette_code ?? null,
      p_session_id: getClientSessionId(),
      p_success: opts.success ?? true,
      p_details: opts.details ?? {}
    });
  } catch (e) {
    // L'audit ne doit jamais bloquer l'application
    console.warn('audit log failed:', e?.message || e);
  }
}



// v11.4.3.3 – client session id (per browser/device). Ensures locks work even with same login on multiple devices.
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
  // v12.2 – release lock when user becomes unauthenticated
  const wasAuth = isAuthenticated;

  const isAuth = !!(session?.user);
  if (wasAuth && !isAuth) {
    try { releaseLock(); } catch(e) { console.error(e); }
    if (typeof setUiReadOnly === 'function') {
      setUiReadOnly(true, "Déconnecté : verrou libéré. Reconnectez-vous pour continuer.");
    }
  }
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
      await logEvent('auth.login', {
        entity_type: 'auth',
        details: { email: email || null }
      });
    } catch(err){ alert('Auth: '+err.message); }
  });
  document.getElementById('btn-logout')?.addEventListener('click', async ()=>{
    await logEvent('auth.logout', { entity_type: 'auth' });
    await signOut();
  });
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

  
  // v12.2 – libérer le verrou de la palette précédente avant de charger une nouvelle palette
  if (currentPaletteId && currentLockToken && lastLoadedCode && code !== lastLoadedCode) {
    try { await releaseLock(); } catch(e) { console.error('releaseLock failed', e); }
  }
const pal = await getOrCreatePaletteByCode(code);
  currentPaletteId = pal.id;
  lastLoadedCode = code;

  // v11.4.3.3: acquire lock
  await acquireLock(currentPaletteId);
  // v11.4.3.3: load photos
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

  await logEvent('palette.load', {
    entity_type: 'palettes',
    entity_id: String(pal.id),
    palette_id: pal.id,
    palette_code: code,
    details: { lines: (lines?.length||0) }
  });
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

  await logEvent('palette.save', {
    entity_type: 'palettes',
    entity_id: String(paletteId),
    palette_id: paletteId,
    palette_code: code,
    details: { lines: payload.length }
  });
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
  $('#export-csv').addEventListener('click', async ()=>{
    await logEvent('ui.export_csv', {
      entity_type: 'palettes',
      entity_id: currentPaletteId ? String(currentPaletteId) : null,
      palette_id: currentPaletteId,
      palette_code: ($('#palette-code')?.value || '').trim() || null
    });
    exportCSV();
  });
  $('#print').addEventListener('click', async ()=>{
    await logEvent('ui.print', {
      entity_type: 'palettes',
      entity_id: currentPaletteId ? String(currentPaletteId) : null,
      palette_id: currentPaletteId,
      palette_code: ($('#palette-code')?.value || '').trim() || null
    });
    window.print();
  });
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
  if (error) {
    // v12.3.3 – normaliser le message pour traitement upstream
    const e = new Error(error.message || 'Storage signed url error');
    e.__storageError = error;
    throw e;
  }
  if (!data?.signedUrl || !String(data.signedUrl).includes('token=')) {
    throw new Error('SIGNED_URL_MISSING_TOKEN');
  }
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
      const card = document.createElement('div');
      card.className = 'palette-photo-card';

      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Photo palette';
      img.className = 'palette-photo-thumb';
      img.loading = 'lazy';

      img.addEventListener('click', ()=>{ window.open(url, '_blank'); });
      img.onerror = () => {
        console.error('Image non affichable. URL:', url);
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.textContent = 'Ouvrir la photo';
        a.style.display = 'inline-block';
        a.style.margin = '6px 8px';
        card.appendChild(a);
      };

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'palette-photo-delete';
      del.title = 'Supprimer la photo';
      del.textContent = '×';
      del.addEventListener('click', async (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        if (isReadOnly) { alert("Palette verrouillée : suppression impossible."); return; }
        if (!confirm("Supprimer cette photo ?")) return;
        try{
          await deletePalettePhoto(p.id, p.path);
        }catch(e){
          console.error(e);
          alert("Erreur suppression photo : " + (e.message || e));
        }
      });

      card.appendChild(img);
      card.appendChild(del);
      container.appendChild(card);
    } catch (e) {
      // (silencieux)
    }
  }
}

async function uploadPalettePhoto(file) {
  // Compression/redimensionnement automatique (utile sur smartphone)
  file = await compressImageFile(file, { maxSize: 1600, quality: 0.82 });
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

  await logEvent('photo.upload', {
    entity_type: 'palette_photos',
    palette_id: currentPaletteId,
    entity_id: null,
    palette_code: ($('#palette-code')?.value || '').trim() || null,
    details: { path: objectPath, size: file.size, type: file.type || null }
  });

  await renderPalettePhotos(currentPaletteId);
}


window.addEventListener('beforeunload', ()=>{ try{ releaseLock(); }catch(e){} });

// v11.4.3.3 – Photo capture / selection
function setupPhotoCapture() {
  const btn = document.getElementById('btn-take-photo');
  const input = document.getElementById('palette-photo-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    // v12.3 – ouvrir l'appareil photo / explorateur peut masquer l'onglet (mobile)
    // On évite de libérer le verrou pendant la prise/sélection de photo.
    isPickingPhoto = true;
    setTimeout(()=>{ isPickingPhoto = false; }, 20000);
    input.value = '';
    input.click();
  });

  input.addEventListener('change', async () => {
    isPickingPhoto = false;
    try {
      if (!currentPaletteId) {
        alert("Veuillez d'abord charger une palette.");
        return;
      }
      const file = input.files && input.files[0];
      if (!file) return;

      const allowed = ['image/jpeg','image/png','image/webp'];
      if (file.type && !allowed.includes(file.type)) {
        alert(`Format non supporté (${file.type}). Choisir une image JPG/PNG/WEBP.`);
        return;
      }

      if (typeof isLocked !== 'undefined' && isLocked) {
        alert("Palette verrouillée : impossible d'ajouter une photo.");
        return;
      }

      // v12.3 – si le lock a été libéré pendant l'ouverture de la caméra, on le reprend
      if (!currentLockToken && typeof acquireLock === 'function') {
        try { await acquireLock(currentPaletteId); } catch(e) { console.error(e); }
      }

      await uploadPalettePhoto(file);
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'envoi de la photo : " + (e.message || e));
    }
  });
}

// v11.4.3.3 – keep palette number in sync
function setupPaletteNumberSync() {
  const el = document.getElementById('palette-number');
  if (!el) return;
  currentPaletteNumber = el.value || null;
  el.addEventListener('input', () => { currentPaletteNumber = el.value || null; });
}


// v11.4.3.3 – Compression/redimensionnement image côté client (Android/desktop)
// - Convertit en JPEG pour réduire la taille
// - Redimensionne sur un max (par défaut 1600px) en conservant le ratio
async function compressImageFile(file, { maxSize = 1600, quality = 0.82 } = {}) {
  if (!file) return file;
  const isImage = (file.type || '').startsWith('image/');
  if (!isImage) return file;

  // Si le navigateur ne supporte pas createImageBitmap, on garde le fichier original
  if (typeof createImageBitmap !== 'function') return file;

  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;

  // Calcul du redimensionnement
  const maxDim = Math.max(width, height);
  let scale = 1;
  if (maxDim > maxSize) scale = maxSize / maxDim;

  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);

  // Export JPEG compressé
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return file;

  const outName = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], outName, { type: 'image/jpeg' });
}


// v11.4.3.3 – Suppression d'une photo (DB + Storage)
async function deletePalettePhoto(photoId, objectPath) {
  if (!currentPaletteId) return;
  if (!photoId || !objectPath) return;

  // v12.3.4 – suppression robuste (cohérente avec RLS):
  // 1) DB d'abord (nécessite lock) 2) Storage ensuite (tolère déjà supprimé) 3) refresh UI

  // 1) Supprimer la référence en base (soumis à RLS: lock requis)
  const { error: dbErr } = await supabase
    .from('palette_photos')
    .delete()
    .eq('id', photoId)
    .eq('palette_id', currentPaletteId);

  if (dbErr) {
    // Si RLS empêche la suppression, on ne supprime PAS le fichier pour éviter les orphelins inverses.
    throw dbErr;
  }

  // 2) Supprimer le fichier dans le bucket (si déjà supprimé, on ignore)
  const { error: stErr } = await supabase.storage
    .from('palette-photos')
    .remove([objectPath]);

  let storageNotFound = false;
  if (stErr) {
    const msg = (stErr && (stErr.message || stErr.error || stErr.toString())) || '';
    if (!String(msg).toLowerCase().includes('not found')) {
      console.warn('Suppression storage a échoué', stErr);
    } else {
      storageNotFound = true;
    }
  }

  // 3) Rafraîchir
  await renderPalettePhotos(currentPaletteId);

  await logEvent('photo.delete', {
    entity_type: 'palette_photos',
    entity_id: String(photoId),
    palette_id: currentPaletteId,
    palette_code: ($('#palette-code')?.value || '').trim() || null,
    details: { path: objectPath, storage_not_found: storageNotFound }
  });
}


// v12.2 – libérer le verrou lors de la sortie de page (plus fiable que beforeunload sur mobile)
window.addEventListener('pagehide', () => { try { releaseLock(); } catch(e) {} });

document.addEventListener('visibilitychange', () => {
  try {
    if (document.hidden) {
      if (isPickingPhoto) return;
      // v12.3 – libération différée : si l'utilisateur revient rapidement, on ne libère pas
      setTimeout(() => {
        try {
          if (document.hidden && !isPickingPhoto) { releaseLock(); }
        } catch(e) { console.error(e); }
      }, 5000);
    }
  } catch(e) { console.error(e); }
});

// v12.3.3 – detect Storage "not found" style errors (Supabase may return 400 + Object not found)
function isNotFoundError(err){
  const msg = (err && (err.message || err.toString())) || '';
  return String(msg).toLowerCase().includes('not found');
}


// v12.3.5 – normaliser un path Storage (évite les paths stockés en URL complète ou préfixés bucket)
function normalizeStoragePath(p){
  if(!p) return p;
  const s = String(p);
  const m = s.match(/\/palette-photos\/(.+?)(\?|$)/);
  if(m && m[1]) return decodeURIComponent(m[1]);
  return s.replace(/^\/?palette-photos\//,'');
}


// v12.4 – sauvegarde localisation dans public.palettes.location
async function savePaletteLocation(paletteId, locationValue){
  if(!paletteId) return;
  const loc = (locationValue ?? '').toString().trim();

  // Mise à jour simple (la palette existe dès qu'elle est chargée/créée)
  const { error } = await supabase
    .from('palettes')
    .update({ location: loc })
    .eq('id', paletteId);

  if(error){
    console.error('Erreur sauvegarde localisation', error);
    throw error;
  }

  await logEvent('palette.location.update', {
    entity_type: 'palettes',
    entity_id: String(paletteId),
    palette_id: paletteId,
    palette_code: ($('#palette-code')?.value || '').trim() || null,
    details: { location: loc || null }
  });
}


// v12.4 – autosave localisation on blur (si palette chargée et non verrouillée)
function setupLocationAutosave(){
  const el = document.getElementById('palette-location');
  if(!el) return;
  el.addEventListener('blur', async ()=>{
    try{
      if(!currentPaletteId) return;
      if(typeof isLocked !== 'undefined' && isLocked) return;
      await savePaletteLocation(currentPaletteId, el.value);
    }catch(e){
      console.error(e);
    }
  });
}
