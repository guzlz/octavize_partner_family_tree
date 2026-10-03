# -*- coding: utf-8 -*-

from odoo import api, models


class PurchaseOrderLine(models.Model):
    _name = 'purchase.order.line'
    _inherit = ['purchase.order.line', 'octavize.duplicate.product.mixin']

    def _duplicate_document(self):
        return self.order_id

    def _duplicate_sibling_lines(self):
        return self.order_id.order_line

    @api.depends('product_id', 'display_type', 'order_id.order_line.product_id')
    def _compute_is_duplicate_product(self):
        return super()._compute_is_duplicate_product()

    @api.onchange('product_id')
    def _onchange_product_id_duplicate_warning(self):
        return self._duplicate_product_warning()
