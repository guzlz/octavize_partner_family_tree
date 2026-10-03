# -*- coding: utf-8 -*-

from odoo import api, models


class AccountMoveLine(models.Model):
    _name = 'account.move.line'
    _inherit = ['account.move.line', 'octavize.duplicate.product.mixin']

    def _duplicate_document(self):
        return self.move_id

    def _duplicate_sibling_lines(self):
        return self.move_id.invoice_line_ids

    def _duplicate_is_countable(self):
        self.ensure_one()
        # Attention : sur account.move.line, display_type vaut 'product'
        # pour les vraies lignes de facture — le test « not display_type »
        # du mixin les écarterait toutes. Les sections, notes et lignes
        # techniques (taxes, échéances, arrondis) portent une autre valeur.
        return bool(self.product_id) and self.display_type == 'product'

    @api.depends('product_id', 'display_type', 'move_id.invoice_line_ids.product_id')
    def _compute_is_duplicate_product(self):
        return super()._compute_is_duplicate_product()

    @api.onchange('product_id')
    def _onchange_product_id_duplicate_warning(self):
        return self._duplicate_product_warning()
