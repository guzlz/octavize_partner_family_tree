# Octavize Partner Family Tree

Module Odoo 19 (Community) autonome qui ajoute une vue "Arbre
Généalogique" pour visualiser la hiérarchie des contacts (sociétés,
filiales, adresses, personnes) sous forme de carte interactive.

## Aperçu

Les captures ci-dessous proviennent de la même fonctionnalité intégrée
dans un module plus large ; l'interface de ce module autonome est
identique (recherche, hiérarchie, fusion, création de devis).

| | |
|---|---|
| ![Menu Family Tree](docs/screenshots/family_tree_01_menu.png) | ![Résultat de recherche](docs/screenshots/family_tree_02_search_result.png) |
| ![Hiérarchie société/filiale](docs/screenshots/family_tree_03_hierarchy.png) | ![Sélection pour fusion](docs/screenshots/family_tree_04_merge_selection.png) |
| ![Confirmation de fusion](docs/screenshots/family_tree_05_merge_confirm.png) | ![Création de devis depuis l'arbre](docs/screenshots/family_tree_06_quote_creation.png) |

## Ce que fait le module

Étend `res.partner` d'une action `action_open_family_tree()` (bouton
"Arbre" sur la fiche contact) qui ouvre une vue kanban custom
(`js_class="octavize_family_tree"`) affichant la hiérarchie complète à
partir de la société racine, avec mise en évidence du contact
d'origine. Le composant OWL (`FamilyTreeController`/`FamilyTreeRenderer`)
gère :

- **Visualisation hiérarchique** en cartes connectées (société → HQ/
  filiales → contacts → adresses de facturation/livraison), avec
  zoom, dépliage/repliage des branches et sélection de racine.
- **Recherche** de contact par nom, avec bascule automatique vers une
  liste de résultats filtrés.
- **Fiche détaillée** en pop-up (nom, fonction, coordonnées, adresse,
  site web, TVA, référence, notes) avec bouton "Modifier" ouvrant le
  formulaire natif `res.partner`.
- **Changement de parent** via un wizard dédié
  (`partner.change.parent.wizard`), avec sélecteur arborescent et
  recherche.
- **Création de contact** directement depuis l'arbre
  (`partner.create.contact.wizard`), ouvrant ensuite la vue centrée sur
  le nouveau contact.
- **Mode fusion** : sélection multiple de contacts, choix du contact
  destination, ré-attachement des enfants et archivage des sources.
- **Création de devis** depuis une carte de l'arbre, avec sélection des
  adresses de facturation/livraison (ouvre `sale.order` pré-rempli).

## Impact sur l'instance

Le mode fusion (`performMerge()`) **ne transfère que la hiérarchie
parent/enfant** (`res.partner.parent_id`) et archive les contacts
sources — il ne migre pas les commandes, factures, opportunités CRM ou
messages liés aux contacts fusionnés (contrairement à un outil de
fusion complet). Voir Limites connues.

## Plateforme et prérequis d'installation

- Odoo 19.0, module Community.
- Dépend de `base`, `contacts`, `web`, `sale` (`sale` est requis pour
  la création de devis depuis l'arbre ; sans lui, seule cette
  fonctionnalité ne serait pas disponible, mais elle est déclarée en
  dépendance dure).
- Aucun groupe de sécurité dédié : les wizards sont accessibles à tout
  utilisateur interne (`security/ir.model.access.csv` sans restriction
  de groupe) ; les droits effectifs suivent ceux déjà en place sur
  `res.partner`.
- Aucune configuration préalable requise.

## Sécurité

Les données de contact (nom, fonction, email, téléphone, adresse,
notes...) affichées dans les pop-up de détail, le sélecteur de parent
et le dialogue de fusion sont échappées avant insertion dans le DOM
(`escapeHtml()`) : un nom ou un champ note contenant du HTML/JS ne
s'exécute pas dans le navigateur de l'utilisateur consultant l'arbre.

## Limites connues

- Le mode fusion ne transfère que `parent_id` des enfants directs et
  archive la source — aucune redirection des ventes, factures,
  activités, messages ou followers liés au contact archivé. À utiliser
  pour du nettoyage de hiérarchie simple, pas comme outil de fusion
  complet de fiches contact.
- Aucune restriction de groupe sur les wizards de changement de parent,
  création de contact ou fusion — tout utilisateur interne standard
  peut les utiliser ; à restreindre par groupe si besoin en production.
- `family_tree_controller.js` est un fichier volumineux (~2400 lignes)
  concentrant logique de rendu, dialogues et actions — pas de
  découpage en composants OWL séparés.
- Aucun test automatisé (`tests/` absent).

## Réutilisation

Module autonome et générique, sans dépendance à un système de
classification de contacts propriétaire — directement réutilisable sur
toute instance Odoo 19 Community avec `contacts` et `sale` installés.

## Licence

LGPL-3 — voir [LICENSE](LICENSE).
