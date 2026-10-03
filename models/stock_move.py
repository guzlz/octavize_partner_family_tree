# -*- coding: utf-8 -*-

from odoo import api, models


class StockMove(models.Model):
    _name = 'stock.move'
    _inherit = ['stock.move', 'octavize.duplicate.product.mixin']

    def _duplicate_document(self):
        # Un mouvement sans transfert (approvisionnement, fabrication) n'a
        # pas de document de saisie : rien à signaler dans ce cas.
        return self.picking_id

    def _duplicate_sibling_lines(self):
        return self.picking_id.move_ids

    @api.depends('product_id', 'picking_id.move_ids.product_id')
    def _compute_is_duplicate_product(self):
        return super()._compute_is_duplicate_product()

    @api.onchange('product_id')
    def _onchange_product_id_duplicate_warning(self):
        return self._duplicate_product_warning()
