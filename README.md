# Inventaire — v10.6-fix

- Titre + header affichent la version.
- Auth masquée si connecté (classe `is-authenticated` + `hidden`).
- Auth sur 3 lignes si non connecté.
- Palette + Charger sur une ligne, actions en dessous.
- Qté 4 chiffres, Désignation élargie.
- Ajout automatique des désignations dans `items` (index unique) lors de la saisie et à la sauvegarde.
- Supabase (URL/anon) intégré.


## v11.2
- Base: v10.8 (index.html conservé, ajouts minimaux)
- Verrouillage palette via RPC acquire/release_palette_lock
- Photos palette via bucket privé `palette-photos` (URLs signées)
