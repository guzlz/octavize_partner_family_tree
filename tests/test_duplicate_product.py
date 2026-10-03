# -*- coding: utf-8 -*-
"""Détection non bloquante des produits saisis plusieurs fois sur un document.

Le mixin est partagé entre devis, commandes d'achat, transferts de stock et
factures. On ne teste ici que la ligne de devis : la logique commune
(``octavize.duplicate.product.mixin``) est la même partout, seule la façon de
retrouver le document parent et les lignes sœurs change d'un modèle à l'autre.
"""

from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestDuplicateProduct(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.customer = cls.env['res.partner'].create({'name': 'ZZ Client test'})
        cls.product_a = cls.env['product.product'].create({'name': 'ZZ Produit A'})
        cls.product_b = cls.env['product.product'].create({'name': 'ZZ Produit B'})

    def test_same_product_on_two_lines_is_flagged(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [
                (0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1}),
                (0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 2}),
            ],
        })
        self.assertTrue(all(order.order_line.mapped('is_duplicate_product')))

    def test_different_products_are_not_flagged(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [
                (0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1}),
                (0, 0, {'product_id': self.product_b.id, 'product_uom_qty': 1}),
            ],
        })
        self.assertFalse(any(order.order_line.mapped('is_duplicate_product')))

    def test_a_single_line_is_never_flagged(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [
                (0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1}),
            ],
        })
        self.assertFalse(order.order_line.is_duplicate_product)

    def test_duplicate_detection_does_not_cross_documents(self):
        self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1})],
        })
        other_order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1})],
        })
        self.assertFalse(other_order.order_line.is_duplicate_product)

    def test_the_onchange_warns_once_per_duplicate(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1})],
        })
        new_line = self.env['sale.order.line'].new({
            'order_id': order.id,
            'product_id': self.product_a.id,
        })
        result = new_line._duplicate_product_warning()
        self.assertTrue(result and 'warning' in result)

    def test_the_onchange_is_silent_without_a_duplicate(self):
        order = self.env['sale.order'].create({
            'partner_id': self.customer.id,
            'order_line': [(0, 0, {'product_id': self.product_a.id, 'product_uom_qty': 1})],
        })
        new_line = self.env['sale.order.line'].new({
            'order_id': order.id,
            'product_id': self.product_b.id,
        })
        self.assertIsNone(new_line._duplicate_product_warning())
