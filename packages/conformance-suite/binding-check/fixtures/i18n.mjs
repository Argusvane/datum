import { form, tr } from "./_util.mjs";
export default {
  id: "i18n", title: "English and French: labels, hints, options, errors",
  definition: form([
    { id: "fullName", type: "text", configuration: { label: "Full name", description: "As it appears on your identification.", required: true } },
    { id: "nickname", type: "text", configuration: { label: "Nickname" } },
    { id: "contact", type: "radio", configuration: { label: "Preferred contact method", required: true, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } }
  ], { translations: { "fr-CA": { components: {
    fullName: { label: tr("Full name", "Nom complet"), description: tr("As it appears on your identification.", "Tel qu'il apparaît sur votre pièce d'identité.") },
    nickname: { label: tr("Nickname", "Surnom") },
    contact: { label: tr("Preferred contact method", "Moyen de communication préféré"), options: { email: { label: tr("Email", "Courriel") }, phone: { label: tr("Phone", "Téléphone") } } }
  },
  // The engine ships English words only: the form's own translations carry the French validation words.
  texts: { messages: { required: { text: "Ce champ est obligatoire.", source: "" } } } } } })
};
