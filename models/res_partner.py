# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # Champs séparant explicitement les enfants "filiales" (sociétés) des
    # enfants "adresses/contacts humains" (livraison, facturation, autre,
    # contact). Le "domain" d'un champ One2many est appliqué par l'ORM au
    # moment de la lecture : contrairement au "domain" posé sur un <field>
    # dans une vue (qui ne filtre PAS l'affichage d'un One2many côté client,
    # seulement le sélecteur d'ajout des Many2many), ce filtre est donc
    # réellement effectif ici, sans jamais toucher au champ standard
    # child_ids (utilisé ailleurs dans Odoo en comptant sur TOUS les enfants).
    address_ids = fields.One2many(
        'res.partner', 'parent_id',
        string='Adresses et contacts',
        domain=[('is_company', '=', False)],
    )

    filiale_ids = fields.One2many(
        'res.partner', 'parent_id',
        string='Filiales',
        domain=[('is_company', '=', True)],
    )

    is_filiale = fields.Boolean(
        string='Est une filiale',
        compute='_compute_is_filiale',
        store=True,
        help="Une société est considérée comme une filiale dès que sa fiche "
             "(société) est rattachée, via le champ Société mère, à une "
             "autre fiche société.",
    )

    filiale_count = fields.Integer(
        string='Nombre de filiales',
        compute='_compute_filiale_count',
    )

    # Vocabulaire unique des étiquettes de rôle, utilisé partout dans le
    # back-office (fiche, liste, kanban, onglet Contacts, onglet Filiales) et
    # repris à l'identique dans l'arbre généalogique (family_tree_controller.js,
    # constante PARTNER_ROLE_LABELS). Toute fiche porte exactement une
    # étiquette, sans exception : une personne sans société parente est un
    # "Particulier seul", une société ni mère ni filiale est une
    # "Société seule".
    partner_role = fields.Selection([
        ('societe_mere', 'Société mère'),
        ('filiale', 'Filiale'),
        ('societe_seule', 'Société seule'),
        ('contact_reference', 'Contact de référence'),
        ('invoice', 'Adresse de facturation'),
        ('delivery', 'Adresse de livraison'),
        ('private', 'Adresse privée'),
        ('other', 'Autre adresse'),
        ('particulier_seul', 'Particulier seul'),
        ('auto_entrepreneur', 'Auto-entrepreneur'),
    ], string='Rôle', compute='_compute_partner_role', store=True)

    # Code couleur (1-6) repris tel quel de la palette utilisée dans l'arbre
    # généalogique (static/src/css/family_tree.css : .o_company_badge,
    # .o_company_badge.subsidiary, .o_type_badge.type-*), pour que les
    # étiquettes de rôle soient visuellement identiques partout dans le
    # back-office et qu'on ne se perde pas en passant de l'arbre aux
    # fiches/listes/kanbans.
    PARTNER_ROLE_COLORS = {
        'filiale': 1,            # bleu (#3b82f6 -> #60a5fa)
        'societe_mere': 2,       # bleu foncé (#1e3a8a -> #3b82f6)
        'invoice': 3,            # cyan (#0ea5e9 -> #38bdf8)
        'delivery': 4,           # orange (#f97316 -> #fb923c)
        'other': 5,              # gris (#6b7280 -> #9ca3af)
        'contact_reference': 6,  # vert (#10b981 -> #34d399)
        'societe_seule': 7,      # violet (#7c3aed -> #a78bfa)
        'particulier_seul': 8,   # rose (#db2777 -> #f472b6)
        'private': 9,            # ambre (#d97706 -> #fbbf24)
        'auto_entrepreneur': 10,  # rose foncé (#9d174d -> #db2777)
    }

    partner_role_color = fields.Integer(
        string='Couleur du rôle',
        compute='_compute_partner_role_color',
        store=True,
    )

    @api.depends('partner_role')
    def _compute_partner_role_color(self):
        for partner in self:
            partner.partner_role_color = self.PARTNER_ROLE_COLORS.get(partner.partner_role, 0)

    @api.depends('is_company', 'parent_id', 'parent_id.is_company')
    def _compute_is_filiale(self):
        for partner in self:
            partner.is_filiale = bool(
                partner.is_company and partner.parent_id and partner.parent_id.is_company
            )

    @api.depends('filiale_ids')
    def _compute_filiale_count(self):
        for partner in self:
            partner.filiale_count = len(partner.filiale_ids)

    @api.depends('is_company', 'is_filiale', 'filiale_ids', 'type', 'parent_id',
                 'vat', 'company_registry')
    def _compute_partner_role(self):
        """Chaque fiche reçoit exactement une étiquette de rôle.

        Une fiche société est soit une filiale (rattachée à une société mère),
        soit une société mère (au moins une filiale), soit une société seule.
        Une fiche personne est d'abord qualifiée par son type d'adresse
        (facturation / livraison / privée), puis, à défaut, par son
        rattachement : rattachée à une société c'est un contact de référence ou
        une autre adresse, sans rattachement c'est un particulier seul.

        Cas particulier de l'auto-entrepreneur : sur une adresse de facturation
        ou de livraison, un numéro de TVA ou un SIRET est une information de
        facturation banale et ne dit rien de la nature du contact. Sur un
        particulier seul en revanche, le renseigner signifie que la personne
        exerce en son nom propre : l'étiquette devient "Auto-entrepreneur".
        Un contact rattaché à une société n'est jamais concerné, le numéro
        qu'il porterait étant celui de sa société.
        """
        for partner in self:
            if partner.is_company:
                if partner.is_filiale:
                    partner.partner_role = 'filiale'
                elif partner.filiale_ids:
                    partner.partner_role = 'societe_mere'
                else:
                    partner.partner_role = 'societe_seule'
            elif partner.type == 'invoice':
                partner.partner_role = 'invoice'
            elif partner.type == 'delivery':
                partner.partner_role = 'delivery'
            elif partner.type == 'private':
                # Type d'adresse supprimé du standard depuis Odoo 17 ; conservé
                # ici pour les bases migrées ou un module tiers qui le rétablit.
                partner.partner_role = 'private'
            elif not partner.parent_id:
                if partner.vat or partner.company_registry:
                    partner.partner_role = 'auto_entrepreneur'
                else:
                    partner.partner_role = 'particulier_seul'
            elif partner.type == 'other':
                partner.partner_role = 'other'
            else:
                partner.partner_role = 'contact_reference'

    def action_open_family_tree(self):
        """Ouvre l'arbre généalogique centré sur ce contact."""
        self.ensure_one()

        # Recherche de la société racine
        root = self
        while root.parent_id:
            root = root.parent_id

        return {
            'type': 'ir.actions.act_window',
            'name': _('Arbre - %s') % root.display_name,
            'res_model': 'res.partner',
            'view_mode': 'kanban',
            'views': [(self.env.ref('octavize_partner_family_tree.view_partner_family_tree').id, 'kanban')],
            'domain': [('id', '=', root.id)],
            'context': {
                'highlight_partner_id': self.id,
                'family_tree_root_id': root.id,
            },
            'target': 'current',
        }

    def action_view_filiales(self):
        """Ouvre la liste des filiales (sociétés enfants) de cette société."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Filiales de %s') % self.display_name,
            'res_model': 'res.partner',
            'view_mode': 'list,form',
            'domain': [('parent_id', '=', self.id), ('is_company', '=', True)],
            'context': {'default_parent_id': self.id, 'default_is_company': True},
        }
