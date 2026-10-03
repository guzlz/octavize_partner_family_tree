# -*- coding: utf-8 -*-
"""Vue Arbre : plusieurs généalogies ouvertes en même temps.

L'arbre est presque entièrement en JavaScript : un test Python ne verrait rien
passer. Ce test pilote donc un vrai navigateur, seul moyen de vérifier que les
panneaux se construisent, que les courbes se dessinent sans erreur et qu'une
généalogie peut être ouverte à côté d'une autre puis refermée.

**Hors du lot standard** (tag ``-standard``) : certains conteneurs de
développement n'autorisent pas Chrome headless à démarrer — il se lance puis
ne répond plus, et le test échouerait pour une raison qui n'a rien à voir avec
le code. Le jouer sur une machine disposant d'un navigateur fonctionnel :

    odoo-bin -u octavize_partner_family_tree --test-enable --test-tags family_tree_browser \
        --stop-after-init
"""

from odoo.tests import HttpCase, tagged


@tagged('-standard', 'post_install', '-at_install', 'family_tree_browser')
class TestFamilyTreeMultiRoot(HttpCase):

    def test_two_genealogies_can_be_open_side_by_side(self):
        Partner = self.env['res.partner']
        alpha = Partner.create({'name': 'ZZ Groupe Alpha', 'is_company': True})
        Partner.create({
            'name': 'ZZ Filiale Alpha', 'is_company': True, 'parent_id': alpha.id,
        })
        beta = Partner.create({'name': 'ZZ Groupe Beta', 'is_company': True})
        Partner.create({
            'name': 'ZZ Filiale Beta', 'is_company': True, 'parent_id': beta.id,
        })

        # Le mot de passe de l'administrateur est retiré sur les bases de
        # développement : le test se connecte, il faut donc le reposer.
        self.env.ref('base.user_admin').write({'password': 'admin'})

        action = self.env.ref('octavize_partner_family_tree.action_partner_family_tree')
        self.start_tour(
            '/odoo/action-%s' % action.id,
            'family_tree_multi',
            login='admin',
        )
