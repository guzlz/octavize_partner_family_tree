# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class ChangeParentWizard(models.TransientModel):
    _name = 'partner.change.parent.wizard'
    _description = 'Réassigner le parent d\'un contact'

    partner_id = fields.Many2one(
        'res.partner',
        string='Contact',
        required=True,
        readonly=True,
    )
    
    partner_name = fields.Char(
        string='Nom du contact',
        related='partner_id.display_name',
        readonly=True,
    )
    
    current_parent_id = fields.Many2one(
        'res.partner',
        string='Parent actuel',
        related='partner_id.parent_id',
        readonly=True,
    )
    
    new_parent_id = fields.Many2one(
        'res.partner',
        string='Nouveau parent',
        domain="[('id', '!=', partner_id)]",
    )

    def action_confirm(self):
        """Appliquer le changement de parent"""
        self.ensure_one()
        self.partner_id.write({
            'parent_id': self.new_parent_id.id if self.new_parent_id else False,
        })
        return {'type': 'ir.actions.act_window_close'}


class CreateContactWizard(models.TransientModel):
    _name = 'partner.create.contact.wizard'
    _description = 'Créer un nouveau contact'

    name = fields.Char(
        string='Nom du contact',
        required=True,
    )
    
    is_company = fields.Boolean(
        string='Est une société',
        default=False,
    )
    
    parent_id = fields.Many2one(
        'res.partner',
        string='Société parente',
    )
    
    contact_type = fields.Selection([
        ('contact', 'Contact'),
        ('invoice', 'Adresse de facturation'),
        ('delivery', 'Adresse de livraison'),
        ('other', 'Autre adresse'),
    ], string='Type', default='contact')

    def action_confirm(self):
        """Créer le contact et ouvrir l'arbre généalogique"""
        self.ensure_one()
        vals = {
            'name': self.name,
            'is_company': self.is_company,
            'parent_id': self.parent_id.id if self.parent_id else False,
            'type': self.contact_type if not self.is_company else 'contact',
        }
        partner = self.env['res.partner'].create(vals)
        root_partner = partner if not partner.parent_id else partner.commercial_partner_id
        return {
            'type': 'ir.actions.act_window',
            'name': _('Arbre généalogique'),
            'res_model': 'res.partner',
            'view_mode': 'kanban',
            'views': [
                (self.env.ref('octavize_partner_family_tree.view_partner_family_tree').id, 'kanban'),
            ],
            'target': 'current',
            'domain': [('id', '=', root_partner.id)],
            'context': {
                'family_tree_root_id': root_partner.id,
                'highlight_partner_id': partner.id,
            }
        }
