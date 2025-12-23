# Inventaire — v10.3

- Titre + header affichent la version.
- Auth masquée si connecté (classe `is-authenticated` + `hidden`).
- Auth sur 3 lignes si non connecté.
- Palette + Charger sur une ligne, actions en dessous.
- Qté 4 chiffres, Désignation élargie.
- En mobile : au clic sur **+ Ligne**, scroll en bas + focus sur la **Désignation**.
- À la sortie du champ **Désignation** : upsert dans `items` + récupération de l'`id`.
- Sauvegarde : chaque ligne reçoit un UUID côté client pour éviter `id=null` sur `pallet_items`.
- Supabase (URL/anon) intégré.
