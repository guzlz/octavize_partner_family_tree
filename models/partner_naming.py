# -*- coding: utf-8 -*-
"""Norme de nommage des fiches contact.

Même mécanique que sur la fiche article : une ligne grise rappelle la règle sous
le nom, et des avertissements orange listent en direct ce qui s'en écarte. Rien
n'est bloquant — un contact mal nommé s'enregistre, il est seulement signalé.

Deux normes distinctes, parce que les règles n'ont rien à voir :
- les fiches société ne sont contrôlées que sur la mise en forme ;
- les fiches personne doivent suivre « NOM Prénom », nom de famille en capitales
  d'abord, prénom en casse normale ensuite.

Les adresses (facturation, livraison, autre) ne sont jamais contrôlées : leur
« nom » est un libellé d'adresse, pas un nom de personne.
"""

import unicodedata

from odoo import api, fields, models

from .naming_norm import DEFAULT_MAX_LENGTH

# Formes juridiques reconnues, françaises et étrangères les plus courantes. Sert
# uniquement à vérifier leur PLACE dans le nom : une société sans forme juridique
# dans son nom est parfaitement normale et n'est jamais signalée.
LEGAL_FORMS = {
    'SARL', 'SAS', 'SASU', 'SA', 'EURL', 'SCI', 'SNC', 'SCOP', 'SCA', 'SELARL',
    'SELAS', 'SCM', 'SCP', 'GIE', 'EI', 'EIRL', 'SEM', 'SEML', 'SCIC',
    'GMBH', 'AG', 'KG', 'OHG', 'UG', 'LTD', 'LLC', 'LLP', 'INC', 'CORP', 'PLC',
    'BV', 'NV', 'SRL', 'SPA', 'SL', 'SLU', 'SA DE CV', 'OY', 'AB', 'AS', 'APS',
}


def _strip_accents(value):
    return ''.join(
        c for c in unicodedata.normalize('NFD', value)
        if unicodedata.category(c) != 'Mn'
    )


def _normalize(token):
    """Comparaison insensible à la casse, aux accents et à la ponctuation.

    « S.A.R.L. », « sarl » et « SARL » doivent être reconnus de la même façon.
    """
    cleaned = ''.join(c for c in _strip_accents(token) if c.isalnum())
    return cleaned.upper()


def _has_letter(token):
    return any(c.isalpha() for c in token)


def _is_caps(token):
    """Un mot écrit entièrement en capitales (les accents comptent : « DEAL », « LE »)."""
    return _has_letter(token) and token == token.upper()


def _spaced_separator(separator):
    separator = separator or '-'
    if separator != separator.strip():
        return separator
    return f" {separator} "


class ResPartnerNaming(models.Model):
    _inherit = 'res.partner'

    naming_norm_hint = fields.Char(
        string="Rappel de la norme de nommage",
        compute='_compute_partner_naming',
        help="Une ligne rappelant la graphie attendue pour ce type de fiche.",
    )
    name_warnings = fields.Text(
        string="Écarts à la norme de nommage",
        compute='_compute_partner_naming',
        help="Ce qui s'écarte de la norme dans le nom de cette fiche. Purement "
             "indicatif : rien n'empêche l'enregistrement.",
    )

    def _naming_target(self):
        """Quelle norme s'applique à cette fiche, ou False si aucune.

        Les adresses sont exclues : « Facturation » ou « Entrepôt Nord » sont des
        libellés d'adresse et n'ont pas à respecter une graphie de nom propre.
        """
        self.ensure_one()
        if self.is_company:
            return 'contact_company'
        if self.type == 'contact':
            return 'contact_person'
        return False

    def _partner_name_warnings(self, name, norm, target):
        """Liste des écarts à la norme pour un nom de contact."""
        warnings = []
        if not name:
            return warnings

        # 0 signifie « pas de limite » : une raison sociale n'a pas à être
        # tronquée. Le repli sur la valeur par défaut ne vaut que si la norme a
        # été supprimée.
        max_length = norm.max_length if norm else DEFAULT_MAX_LENGTH
        separator = _spaced_separator(norm.separator or '-')

        # --- mise en forme, commune aux sociétés et aux personnes ---
        if max_length and len(name) > max_length:
            warnings.append(
                "Le nom fait %s caractères, le maximum est %s." % (len(name), max_length)
            )
        if '  ' in name:
            warnings.append("Le nom contient un double espace.")
        if name != name.strip():
            warnings.append("Le nom commence ou finit par un espace.")

        if target == 'contact_company':
            warnings += self._company_order_warnings(name)
            return warnings

        if target != 'contact_person':
            return warnings

        # --- graphie « NOM Prénom », sur la partie civile du nom ---
        civil, _sep, commercial = name.strip().partition(separator)
        mots = [m for m in civil.split() if _has_letter(m)]

        if len(mots) < 2:
            warnings.append(
                "Le nom doit comporter le nom de famille puis le prénom "
                "(par exemple « DUPONT Jean »)."
            )
        else:
            capitales = [i for i, m in enumerate(mots) if _is_caps(m)]
            normales = [i for i, m in enumerate(mots) if not _is_caps(m)]
            if not capitales:
                warnings.append(
                    "Le nom de famille doit être en capitales (par exemple « DUPONT Jean »)."
                )
            elif not normales:
                warnings.append(
                    "Le nom est entièrement en capitales : le prénom s'écrit en casse "
                    "normale (par exemple « DUPONT Jean »)."
                )
            elif min(normales) < max(capitales):
                warnings.append(
                    "Les noms sont dans l'ordre inverse : le nom de famille en capitales "
                    "d'abord, puis le prénom (par exemple « DUPONT Jean »)."
                )

        # --- auto-entrepreneur : le nom commercial complète le nom civil ---
        if self.partner_role == 'auto_entrepreneur' and not commercial.strip():
            warnings.append(
                "Fiche Auto-entrepreneur : ajoutez le nom commercial après « %s » "
                "(par exemple « DUPONT Jean %s Mon Activité »)."
                % (norm.separator or '-', norm.separator or '-')
            )

        return warnings

    def _company_order_warnings(self, name):
        """Ordre attendu : nom de société, puis forme juridique, puis ville.

        On ne vérifie que la PLACE des éléments présents. Une société sans forme
        juridique ni ville dans son nom est la situation la plus courante et ne
        doit rien déclencher.
        """
        warnings = []
        mots = [m for m in name.split() if _normalize(m)]
        if not mots:
            return warnings

        normalises = [_normalize(m) for m in mots]
        formes = [i for i, m in enumerate(normalises) if m in LEGAL_FORMS]

        if formes and formes[0] == 0:
            warnings.append(
                "La forme juridique « %s » est placée avant le nom de société : "
                "elle se met après (par exemple « Dupont SARL »)." % mots[0]
            )

        # La ville n'est contrôlée que si la fiche en porte une : sans elle, on
        # ne peut pas distinguer un nom de ville d'un nom de société.
        if self.city and formes:
            ville = _normalize(self.city)
            positions_ville = [i for i, m in enumerate(normalises) if m == ville]
            if positions_ville and positions_ville[0] < formes[-1]:
                warnings.append(
                    "La ville « %s » est placée avant la forme juridique : elle se "
                    "met en dernier (par exemple « Dupont SARL %s »)."
                    % (self.city, self.city)
                )
        return warnings

    @api.depends('name', 'is_company', 'type', 'partner_role', 'city')
    def _compute_partner_naming(self):
        Norm = self.env['naming.norm']
        normes = {}
        for partner in self:
            target = partner._naming_target()
            if not target:
                partner.naming_norm_hint = False
                partner.name_warnings = False
                continue
            if target not in normes:
                normes[target] = Norm._get_norm(target)
            norm = normes[target]
            if not norm:
                partner.naming_norm_hint = False
                partner.name_warnings = False
                continue
            partner.naming_norm_hint = norm._hint_line()
            warnings = partner._partner_name_warnings(partner.name, norm, target)
            partner.name_warnings = "\n".join(warnings) if warnings else False
