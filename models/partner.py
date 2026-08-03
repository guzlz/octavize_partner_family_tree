# -*- coding: utf-8 -*-

from odoo import models, fields, api, _


class ResPartner(models.Model):
    _inherit = 'res.partner'

    def action_open_family_tree(self):
        """Open family tree view centered on this partner"""
        self.ensure_one()
        
        # Find the root company
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
