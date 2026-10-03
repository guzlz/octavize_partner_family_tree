# -*- coding: utf-8 -*-

from odoo import api, fields, models
from odoo.exceptions import ValidationError

DEFAULT_MAX_LENGTH = 80
DEFAULT_SEPARATOR = '-'


class NamingNorm(models.Model):
    """Single record holding the naming standard for a kind of contact.

    The standard is written down **once** here and consumed from two places: the
    contact form (inline help + live warnings) and this configuration screen.
    Keeping it in the database (instead of hard-coding it) lets an administrator
    adjust the wording, the maximum length or the separator without a new module
    release.
    """
    _name = 'naming.norm'
    _description = "Naming Standard"
    _order = 'applies_to, id'

    applies_to = fields.Selection(
        [
            ('contact_company', "Contact - company"),
            ('contact_person', "Contact - person"),
        ],
        string="Applies to",
        required=True,
        default='contact_person',
        help="Which records this standard governs. One standard per target: a "
             "contact form reads the company or the person standard depending on "
             "the kind of record.",
    )

    name = fields.Char(
        string="Title",
        required=True,
        default="Naming standard",
        translate=True,
    )
    name_format = fields.Char(
        string="Format",
        required=True,
        translate=True,
        default="LAST NAME First name",
        help="One-line summary of the expected structure of a name.",
    )
    rule_text = fields.Text(
        string="Rule",
        translate=True,
        help="Full text of the standard, shown under the name on the form.",
    )
    examples = fields.Text(
        string="Examples",
        translate=True,
        help="One compliant example per line.",
    )
    max_length = fields.Integer(
        string="Maximum length",
        required=True,
        default=DEFAULT_MAX_LENGTH,
        help="Maximum number of characters allowed. 0 means no limit.",
    )
    hint_line = fields.Char(
        string="Inline hint",
        translate=True,
        help="The single grey line shown under the name on the form. Left empty, a "
             "line is built from the format and the maximum length.",
    )
    separator = fields.Char(
        string="Separator",
        required=True,
        default=DEFAULT_SEPARATOR,
        help="Character sequence separating the civil name from a trade name "
             "(sole trader naming a business after their own name).",
    )

    @api.constrains('max_length')
    def _check_max_length(self):
        for norm in self:
            if norm.max_length < 0:
                raise ValidationError(
                    self.env._("The maximum length cannot be negative. Use 0 for no limit.")
                )

    @api.model_create_multi
    def create(self, vals_list):
        norms = super().create(vals_list)
        self._check_singleton()
        return norms

    @api.model
    def _check_singleton(self):
        """One standard per target: company, or person."""
        for applies_to in set(self.search([]).mapped('applies_to')):
            if self.search_count([('applies_to', '=', applies_to)]) > 1:
                label = dict(self._fields['applies_to'].selection)[applies_to]
                raise ValidationError(self.env._(
                    "There can only be one naming standard for \"%(target)s\". Edit the "
                    "existing one instead of creating a second record.",
                    target=label,
                ))

    @api.model
    def _get_norm(self, applies_to='contact_person'):
        """Return the naming standard for a target, or an empty recordset.

        Callers must always fall back on the module defaults (``norm.max_length or
        DEFAULT_MAX_LENGTH``), because an empty recordset yields falsy field values.
        Deliberately never creates a record: this is called from computed fields,
        which must stay side-effect free.
        """
        return self.sudo().search([('applies_to', '=', applies_to)], limit=1, order='id')

    def action_open_norm(self):
        """Open the naming standards (used by the menu item).

        There is one record per target (contact company, contact person), so the
        menu opens the list and not a single record.
        """
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'naming.norm',
            'view_mode': 'list,form',
            'target': 'current',
            'name': self.env._("Naming Standards"),
        }

    def _hint_line(self):
        """One short line for the form.

        The full standard is long on purpose; printing it under every name turns
        the form into a wall of grey text. The line below is the reminder, and the
        complete text stays one hover away, in the tooltip of the Name field.
        """
        self.ensure_one()
        if self.hint_line:
            return self.hint_line
        if not self.max_length:
            return self.name_format or ''
        return self.env._(
            "%(format)s · %(count)s characters max.",
            format=self.name_format or '',
            count=self.max_length,
        )
