# -*- coding: utf-8 -*-
"""Norme de nommage des fiches contact.

La règle retenue est « NOM Prénom » : nom de famille en capitales d'abord,
prénom en casse normale ensuite. Les avertissements ne bloquent jamais
l'enregistrement, ils signalent seulement l'écart.
"""

from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestPartnerNaming(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Partner = cls.env['res.partner']
        cls.company = cls.Partner.create({'name': 'ZZ Societe mere', 'is_company': True})

    def _warnings(self, name, **vals):
        partner = self.Partner.create(dict({'name': name}, **vals))
        return partner.name_warnings or ''

    # ------------------------------------------------------------------ normes

    def test_there_is_one_standard_per_target(self):
        Norm = self.env['naming.norm']
        for target in ('contact_company', 'contact_person'):
            self.assertTrue(
                Norm._get_norm(target),
                "Il manque la norme de nommage pour la cible %s." % target,
            )

    def test_the_person_standard_is_the_one_used_on_a_person(self):
        partner = self.Partner.create({'name': 'DUPONT Jean'})
        self.assertEqual(partner._naming_target(), 'contact_person')

    def test_the_company_standard_is_the_one_used_on_a_company(self):
        self.assertEqual(self.company._naming_target(), 'contact_company')

    # ------------------------------------------------- graphie « NOM Prénom »

    def test_a_compliant_name_raises_no_warning(self):
        for name in ("DUPONT Jean", "LE GUEN Marie", "DE LA CROIX Anne",
                     "DUPONT Jean-Pierre", "O'BRIEN Sean", "ÉTIENNE Agnès"):
            with self.subTest(name=name):
                self.assertFalse(self._warnings(name), "%s devrait être conforme." % name)

    def test_a_name_without_capitals_is_reported(self):
        self.assertIn("capitales", self._warnings("Jean Dupont"))

    def test_a_reversed_name_is_reported(self):
        self.assertIn("ordre inverse", self._warnings("Jean DUPONT"))

    def test_a_name_entirely_in_capitals_is_reported(self):
        self.assertIn("entièrement en capitales", self._warnings("JEAN DUPONT"))

    def test_a_single_word_name_is_reported(self):
        self.assertIn("nom de famille puis le prénom", self._warnings("Dupont"))

    # ------------------------------------------------------------ mise en forme

    def test_a_double_space_is_reported(self):
        self.assertIn("double espace", self._warnings("DUPONT  Jean"))

    def test_a_surrounding_space_is_reported(self):
        self.assertIn("espace", self._warnings("DUPONT Jean "))

    def test_a_name_longer_than_the_maximum_is_reported(self):
        norm = self.env['naming.norm']._get_norm('contact_person')
        long_name = "DUPONT " + "a" * (norm.max_length + 10)
        self.assertIn("maximum", self._warnings(long_name))

    # -------------------------------------------------------- auto-entrepreneur

    def test_an_auto_entrepreneur_must_carry_a_trade_name(self):
        warnings = self._warnings("DUPONT Jean", vat='FR23334175221')
        self.assertIn("nom commercial", warnings)

    def test_an_auto_entrepreneur_with_a_trade_name_is_compliant(self):
        self.assertFalse(self._warnings("DUPONT Jean - Mon Activité",
                                        vat='FR23334175221'))

    def test_a_plain_individual_does_not_need_a_trade_name(self):
        self.assertFalse(self._warnings("DUPONT Jean"))

    # ------------------------------------------------------- périmètre exclu

    def test_a_company_is_not_checked_on_the_person_rules(self):
        self.assertFalse(self._warnings("Acme Corp", is_company=True))

    def test_an_address_is_never_checked(self):
        partner = self.Partner.create({
            'name': 'Facturation Nord', 'type': 'invoice', 'parent_id': self.company.id,
        })
        self.assertFalse(partner._naming_target())
        self.assertFalse(partner.name_warnings)
        self.assertFalse(partner.naming_norm_hint)

    # ------------------------------------------- ordre du nom d'une société

    def test_a_company_name_alone_is_compliant(self):
        for name in ("Acme Corp", "L'Oréal Professionnel", "Dupont SARL"):
            with self.subTest(name=name):
                self.assertFalse(self._warnings(name, is_company=True))

    def test_a_legal_form_before_the_name_is_reported(self):
        self.assertIn("forme juridique", self._warnings("SARL Dupont", is_company=True))

    def test_a_punctuated_legal_form_is_recognised(self):
        self.assertIn("forme juridique", self._warnings("S.A.R.L. Dupont", is_company=True))

    def test_the_city_must_come_after_the_legal_form(self):
        warnings = self._warnings("Dupont Bordeaux SARL", is_company=True, city='Bordeaux')
        self.assertIn("ville", warnings)

    def test_the_city_in_last_position_is_compliant(self):
        self.assertFalse(
            self._warnings("Dupont SARL Bordeaux", is_company=True, city='Bordeaux')
        )

    def test_a_company_without_a_legal_form_is_never_reported_for_order(self):
        self.assertFalse(self._warnings("Dupont Bordeaux", is_company=True, city='Bordeaux'))

    def test_a_company_name_has_no_length_limit(self):
        # Une raison sociale n'a pas à être tronquée : la norme société porte
        # max_length = 0, qui signifie « pas de limite ».
        self.assertFalse(self._warnings("A" * 200, is_company=True))

    def test_the_company_standard_carries_no_maximum(self):
        norm = self.env['naming.norm']._get_norm('contact_company')
        self.assertEqual(norm.max_length, 0)
        self.assertNotIn("max", norm._hint_line().lower())

    # ---------------------------------------------------------- non bloquant

    def test_a_non_compliant_name_still_saves(self):
        partner = self.Partner.create({'name': 'Jean Dupont'})
        self.assertTrue(partner.id, "Un nom non conforme doit tout de même s'enregistrer.")
        self.assertTrue(partner.name_warnings)

    def test_the_hint_is_shown_and_differs_per_target(self):
        person = self.Partner.create({'name': 'DUPONT Jean'})
        self.assertTrue(person.naming_norm_hint)
        self.assertNotEqual(person.naming_norm_hint, self.company.naming_norm_hint)
