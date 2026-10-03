# -*- coding: utf-8 -*-

from collections import Counter

from odoo import _, models, fields


class DuplicateProductMixin(models.AbstractModel):
    """Signalement non bloquant des produits saisis plusieurs fois.

    Sur un même document (devis, commande d'achat, transfert, facture), il
    arrive qu'un utilisateur ajoute un produit déjà présent sur une autre
    ligne — typiquement parce que le document est long ou qu'il a été repris
    à plusieurs. Rien n'interdit ce doublon (il est parfois voulu : deux
    dates de livraison, deux lots), on se contente donc de le rendre
    visible.

    Deux mécanismes complémentaires, volontairement redondants :

    * ``_duplicate_product_warning`` alimente un ``onchange`` qui prévient
      l'utilisateur au moment de la saisie ;
    * ``is_duplicate_product`` colore la ligne en orange dans la liste.

    L'onchange ne se déclenche pas lorsque les lignes sont ajoutées par le
    catalogue, par un import ou par duplication du document ; la coloration,
    elle, fonctionne dans tous les cas. D'où les deux.
    """

    _name = 'octavize.duplicate.product.mixin'
    _description = "Détection des produits en doublon sur un document"

    is_duplicate_product = fields.Boolean(
        string="Produit en doublon",
        compute='_compute_is_duplicate_product',
        help="Vrai lorsque le même produit apparaît sur au moins deux lignes "
             "du document. Sert uniquement à colorer la ligne : aucun "
             "contrôle bloquant n'y est attaché.",
    )

    # ------------------------------------------------------------------
    # À implémenter par les modèles concrets
    # ------------------------------------------------------------------

    def _duplicate_document(self):
        """Document parent de la ligne (commande, transfert, facture)."""
        raise NotImplementedError

    def _duplicate_sibling_lines(self):
        """Lignes du document parent, ligne courante comprise."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Logique commune
    # ------------------------------------------------------------------

    def _duplicate_is_countable(self):
        """La ligne participe-t-elle au comptage des doublons ?

        Écarte les sections et les notes, qui n'ont pas de produit et ne
        sont de toute façon pas comparables entre elles.
        """
        self.ensure_one()
        # display_type est absent de stock.move, d'où le getattr.
        return bool(self.product_id) and not getattr(self, 'display_type', False)

    def _compute_is_duplicate_product(self):
        # Un Counter par document plutôt qu'un filtered() par ligne : le
        # calcul reste linéaire, même sur un document de plusieurs
        # centaines de lignes.
        counts_by_document = {}
        for line in self:
            document = line._duplicate_document()
            if not document or document.id in counts_by_document:
                continue
            counts_by_document[document.id] = Counter(
                sibling.product_id.id
                for sibling in line._duplicate_sibling_lines()
                if sibling._duplicate_is_countable()
            )
        for line in self:
            document = line._duplicate_document()
            counts = counts_by_document.get(document.id) if document else None
            line.is_duplicate_product = bool(
                counts
                and line._duplicate_is_countable()
                and counts[line.product_id.id] > 1
            )

    def _duplicate_product_warning(self):
        """Avertissement si le produit de la ligne figure déjà sur le document.

        Renvoie un dictionnaire d'onchange, ou None s'il n'y a rien à
        signaler. Non bloquant : Odoo affiche la popup et conserve la ligne.
        """
        self.ensure_one()
        if not self._duplicate_is_countable():
            return None
        # « - self » plutôt qu'une comparaison d'identité : selon le moment
        # où l'onchange se déclenche, la ligne courante figure ou non déjà
        # parmi les lignes du document. La soustraction de recordset couvre
        # les deux cas sans faux positif.
        others = self._duplicate_sibling_lines() - self
        duplicates = others.filtered(
            lambda line: line._duplicate_is_countable()
            and line.product_id == self.product_id
        )
        if not duplicates:
            return None
        return {
            'warning': {
                'title': _("Produit en doublon"),
                'message': _(
                    "Attention, vous avez déjà inséré « %s » dans ce document.",
                    self.product_id.display_name,
                ),
            },
        }
