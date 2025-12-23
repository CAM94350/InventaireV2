# Inventaire — v10.1

## Changements

- Version centralisée dans `app.js` (source unique) :
  - le `<title>`, le titre de page et le footer sont mis à jour automatiquement au chargement.
- Auth masquée si connecté (classe `is-authenticated` + `hidden`).
- Auth sur 3 lignes si non connecté.
- Palette + Charger sur une ligne, actions en dessous.
- Qté 4 chiffres, Désignation élargie.
- Ajout automatique des désignations dans `items` (index unique) lors de la saisie et à la sauvegarde.
- Supabase (URL/anon) intégré.
