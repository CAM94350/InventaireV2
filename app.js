// Inventaire Cloud — v6.6
const VERSION = "v10.6";
document.title = `Inventaire — ${VERSION}`;

const SUPABASE_URL = "https://cypxkiqaemuclcbdtgtw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cHhraXFhZW11Y2xjYmR0Z3R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0MTY3MzksImV4cCI6MjA4MTk5MjczOX0.rHSZBiz68osvqPvpoDhVFGu8l5-j7CVpB5mEVSxRG9Y";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

const $ = (sel, root=document)=>root.querySelector(sel);
const $all = (sel, root=document)=>Array.from(root.querySelectorAll(sel));
let currentPaletteId = null; let isAuthenticated = false; let lastLoadedCode = '';

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

async function ensureItemExists(designation){
  const name = (designation||'').trim(); if(!name) return;
  if(!isAuthenticated) return; // RLS
  const { error } = await supabase
    .from('items')
    .upsert({ designation: name }, { onConflict: 'designation' });
  if(error) console.warn('items upsert error:', error.message);
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

  // Mise à jour de la localisation sur la palette
  const location = ($('#palette-location')?.value || '').trim() || null;
  {
    const { error: eLoc } = await supabase.from('palettes').update({ location }).eq('id', paletteId);
    if(eLoc){ alert(eLoc.message); return; }
  }

  const trs = $all('#table-body tr'); if(trs.length===0){ setStatus('Rien à sauvegarder'); return; }
  const rows = trs.map(serializeRow);
  const payload = rows.map(r=>({ id: r.id || undefined, palette_id: paletteId, designation: r.designation, qty: Math.max(0, r.qty), updated_at: new Date().toISOString() }));
  const { data, error } = await supabase
    .from('pallet_items')
    .upsert(payload, { onConflict:'id' }).select('id');
  if(error){ alert(error.message); return; }
  const trs2 = $all('#table-body tr'); data.forEach((row,i)=>{ if(!trs2[i].dataset.rowId) trs2[i].dataset.rowId=row.id; });

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

function addRow(){ $('#table-body').appendChild(newRow()); }

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

function handleDesignationChange(e){
  const input = e.target.closest('.designation'); if(!input) return;
  const text = input.value.trim(); if(!text) return;
  ensureItemExists(text);
}

function bindUI(){
  $('#btn-load-palette').addEventListener('click', ()=>loadPaletteByCode($('#palette-code').value.trim()));
  $('#palette-code').addEventListener('input', ()=>{
    const code = $('#palette-code').value.trim();
    if(code !== lastLoadedCode){
      currentPaletteId = null;
      const loc = $('#palette-location'); if(loc) loc.value = '';
      setStatus('');
    }
  });
  $('#add-row').addEventListener('click', addRow);
  $('#save').addEventListener('click', saveCurrentPalette);
  $('#export-csv').addEventListener('click', exportCSV);
  $('#print').addEventListener('click', ()=>window.print());
  $('#table-body').addEventListener('click', handleQtyButtons);
  $('#table-body').addEventListener('keydown', handleQtyKey);
  $('#table-body').addEventListener('click', focusQtyOnDesignationClick);
  $('#table-body').addEventListener('change', handleDesignationChange);
}

async function main(){
  bindUI();
  bindAuthHandlers();
  await initAuthUI();
  const h1 = document.querySelector('h1'); if(h1) h1.textContent = `Inventaire — ${VERSION}`;
}

main();
