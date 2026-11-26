import type { FormDefinition } from "../core/schema/types.js";

/**
 * The canonical fixture form: every component the engine
 * ships, in every state a theme dresses — a required text field with a hint and a help
 * mark, a number with affixes, a counted textarea, a select, radios with option hints,
 * checkboxes, a lone checkbox, a date, a file field, every button variant and size (all but
 * the small one in a button group; the small one alone), author
 * html and an image, a labelled group, a panel, tabs, steps and a grid — in English and
 * French. One form serves the theme test kit (`formMarkupClassNames`, `partTemplateViolations`,
 * the standard markers), the web components' accessibility audit (which keeps a JSON copy a
 * test holds equal to this) and the comparison and visual harnesses, so "every part" means
 * the same parts everywhere.
 */
export const FIXTURE_FORM: FormDefinition = {
  "id": "a11y-audit",
  "version": "1.0.0",
  "schemaVersion": "1",
  "localization": {
    "defaultLocale": "en",
    "supportedLocales": [
      {
        "code": "en",
        "label": "English"
      },
      {
        "code": "fr-CA",
        "label": "Français (Canada)"
      }
    ]
  },
  "root": {
    "id": "root",
    "type": "form",
    "configuration": {
      "title": "Accessibility audit"
    },
    "children": {
      "content": [
        {
          "id": "fullName",
          "type": "text",
          "configuration": {
            "label": "Full name",
            "description": "First and last name",
            "tooltip": "As it appears on your ID",
            "required": true,
            "autocomplete": "name"
          }
        },
        {
          "id": "amount",
          "type": "number",
          "configuration": {
            "label": "Amount",
            "prefix": "$",
            "suffix": "CAD"
          }
        },
        {
          "id": "bio",
          "type": "textarea",
          "configuration": {
            "label": "About you",
            "maxLength": 200,
            "characterCount": true
          }
        },
        {
          "id": "province",
          "type": "select",
          "configuration": {
            "label": "Province",
            "options": [
              {
                "value": "AB",
                "label": "Alberta"
              },
              {
                "value": "BC",
                "label": "British Columbia"
              },
              {
                "value": "QC",
                "label": "Québec"
              }
            ]
          }
        },
        {
          "id": "birthDate",
          "type": "date",
          "configuration": {
            "label": "Date of birth",
            "description": "For example, 27 3 2007"
          }
        },
        {
          "id": "attachment",
          "type": "file",
          "configuration": {
            "label": "Supporting document",
            "storage": "base64"
          }
        },
        {
          "id": "contactMethod",
          "type": "radio",
          "configuration": {
            "label": "Preferred contact method",
            "options": [
              {
                "value": "email",
                "label": "Email",
                "description": "We reply within two days"
              },
              {
                "value": "phone",
                "label": "Phone"
              }
            ]
          }
        },
        {
          "id": "interests",
          "type": "checkboxes",
          "configuration": {
            "label": "Interests",
            "options": [
              {
                "value": "news",
                "label": "Newsletter"
              },
              {
                "value": "events",
                "label": "Events"
              }
            ]
          }
        },
        {
          "id": "agree",
          "type": "checkbox",
          "configuration": {
            "label": "I agree to the terms"
          }
        },
        {
          "id": "hiddenLabel",
          "type": "text",
          "configuration": {
            "label": "Search",
            "hideLabel": true,
            "placeholder": "Search"
          }
        },
        {
          "id": "disabledField",
          "type": "text",
          "configuration": {
            "label": "Reference number",
            "disabled": true
          }
        },
        {
          "id": "readOnlyField",
          "type": "text",
          "configuration": {
            "label": "Account",
            "readOnly": true
          }
        },
        {
          "id": "intro",
          "type": "html",
          "configuration": {
            "tag": "div",
            "content": "<h2>About this form</h2><p>Read the <a href=\"#terms\">terms</a> before you continue.</p><ul><li>One</li><li>Two</li></ul>"
          }
        },
        {
          "id": "logo",
          "type": "image",
          "configuration": {
            "src": "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='40'%3E%3Crect width='120' height='40' fill='%23345'/%3E%3C/svg%3E",
            "alt": "Datum",
            "width": 120,
            "height": 40
          }
        },
        {
          "id": "group",
          "type": "fieldset",
          "configuration": {
            "label": "Address"
          },
          "children": {
            "content": [
              {
                "id": "street",
                "type": "text",
                "configuration": {
                  "label": "Street"
                }
              },
              {
                "id": "city",
                "type": "text",
                "configuration": {
                  "label": "City"
                }
              }
            ]
          }
        },
        {
          "id": "grid",
          "type": "grid",
          "configuration": {
            "label": "Contact",
            "columns": 2
          },
          "children": {
            "column_1": [
              {
                "id": "email",
                "type": "text",
                "configuration": {
                  "label": "Email",
                  "autocomplete": "email"
                }
              }
            ],
            "column_2": [
              {
                "id": "phone",
                "type": "text",
                "configuration": {
                  "label": "Phone",
                  "autocomplete": "tel"
                }
              }
            ]
          }
        },
        {
          "id": "panel",
          "type": "panel",
          "configuration": {
            "label": "Employment"
          },
          "children": {
            "content": [
              {
                "id": "employer",
                "type": "text",
                "configuration": {
                  "label": "Employer"
                }
              }
            ]
          }
        },
        {
          "id": "tabs",
          "type": "tabs",
          "configuration": {
            "tabs": [
              {
                "id": "tab_1",
                "label": "Personal"
              },
              {
                "id": "tab_2",
                "label": "Work"
              }
            ]
          },
          "children": {
            "tab_1": [
              {
                "id": "nickname",
                "type": "text",
                "configuration": {
                  "label": "Nickname"
                }
              }
            ],
            "tab_2": [
              {
                "id": "jobTitle",
                "type": "text",
                "configuration": {
                  "label": "Job title"
                }
              }
            ]
          }
        },
        {
          "id": "steps",
          "type": "steps",
          "configuration": {},
          "children": {
            "content": [
              {
                "id": "step_1",
                "type": "step",
                "configuration": {
                  "label": "Eligibility"
                },
                "children": {
                  "content": [
                    {
                      "id": "resident",
                      "type": "checkbox",
                      "configuration": {
                        "label": "I am a resident"
                      }
                    }
                  ]
                }
              },
              {
                "id": "step_2",
                "type": "step",
                "configuration": {
                  "label": "Review"
                },
                "children": {
                  "content": [
                    {
                      "id": "notes",
                      "type": "textarea",
                      "configuration": {
                        "label": "Notes"
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
        {
          "id": "container",
          "type": "container",
          "configuration": {
            "label": "Consent"
          },
          "children": {
            "content": [
              {
                "id": "consent",
                "type": "checkbox",
                "configuration": {
                  "label": "Contact me about my application"
                }
              }
            ]
          }
        },
        {
          "id": "buttonGroup",
          "type": "button-group",
          "children": {
            "content": [
              {
                "id": "submit",
                "type": "button",
                "configuration": {
                  "label": "Submit",
                  "action": "submit",
                  "variant": "primary"
                }
              },
              {
                "id": "buttonSecondary",
                "type": "button",
                "configuration": {
                  "label": "Save for later",
                  "variant": "secondary"
                }
              },
              {
                "id": "buttonSuccess",
                "type": "button",
                "configuration": {
                  "label": "Approve",
                  "variant": "success"
                }
              },
              {
                "id": "buttonDanger",
                "type": "button",
                "configuration": {
                  "label": "Delete",
                  "variant": "danger"
                }
              },
              {
                "id": "buttonWarning",
                "type": "button",
                "configuration": {
                  "label": "Flag",
                  "variant": "warning"
                }
              },
              {
                "id": "buttonInfo",
                "type": "button",
                "configuration": {
                  "label": "Learn more",
                  "variant": "info"
                }
              },
              {
                "id": "buttonLight",
                "type": "button",
                "configuration": {
                  "label": "Cancel",
                  "variant": "light"
                }
              },
              {
                "id": "buttonDark",
                "type": "button",
                "configuration": {
                  "label": "Archive",
                  "variant": "dark"
                }
              },
              {
                "id": "buttonLink",
                "type": "button",
                "configuration": {
                  "label": "Skip",
                  "variant": "link"
                }
              }
            ]
          }
        },
        {
          "id": "buttonSmall",
          "type": "button",
          "configuration": {
            "label": "Reset",
            "variant": "secondary",
            "size": "sm"
          }
        }
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Audit d'accessibilité",
          "source": "5cbnxs"
        }
      },
      "components": {
        "fullName": {
          "label": {
            "text": "Nom complet",
            "source": "13z0t9r"
          },
          "description": {
            "text": "Prénom et nom",
            "source": "147b0fj"
          },
          "tooltip": {
            "text": "Tel qu'inscrit sur votre pièce d'identité",
            "source": "1mg0fkl"
          }
        },
        "amount": {
          "label": {
            "text": "Montant",
            "source": "a2ky21"
          },
          "suffix": {
            "text": "$ CA",
            "source": "fwewvr"
          }
        },
        "bio": {
          "label": {
            "text": "À propos de vous",
            "source": "1hah3md"
          }
        },
        "province": {
          "label": {
            "text": "Province",
            "source": "15zdv1h"
          },
          "options": {
            "BC": {
              "label": {
                "text": "Colombie-Britannique",
                "source": "y28c38"
              }
            }
          }
        },
        "birthDate": {
          "label": {
            "text": "Date de naissance",
            "source": "15n54cn"
          },
          "description": {
            "text": "Par exemple, 27 3 2007",
            "source": "i8gfh3"
          }
        },
        "attachment": {
          "label": {
            "text": "Document à l'appui",
            "source": "1vt3uh5"
          }
        },
        "contactMethod": {
          "label": {
            "text": "Mode de contact préféré",
            "source": "1asuvwb"
          },
          "options": {
            "email": {
              "label": {
                "text": "Courriel",
                "source": "inbfc7"
              },
              "description": {
                "text": "Réponse sous deux jours",
                "source": "1a1e61l"
              }
            },
            "phone": {
              "label": {
                "text": "Téléphone",
                "source": "kb2lhr"
              }
            }
          }
        },
        "interests": {
          "label": {
            "text": "Intérêts",
            "source": "1wsqa2o"
          },
          "options": {
            "news": {
              "label": {
                "text": "Infolettre",
                "source": "oapagq"
              }
            },
            "events": {
              "label": {
                "text": "Événements",
                "source": "217z8"
              }
            }
          }
        },
        "agree": {
          "label": {
            "text": "J'accepte les conditions",
            "source": "onztot"
          }
        },
        "hiddenLabel": {
          "label": {
            "text": "Recherche",
            "source": "1j0itop"
          }
        },
        "disabledField": {
          "label": {
            "text": "Numéro de référence",
            "source": "14fp0jf"
          }
        },
        "readOnlyField": {
          "label": {
            "text": "Compte",
            "source": "oyp43g"
          }
        },
        "logo": {
          "alt": {
            "text": "Datum",
            "source": "o4j91o"
          }
        },
        "group": {
          "label": {
            "text": "Adresse",
            "source": "v2y2ur"
          }
        },
        "street": {
          "label": {
            "text": "Rue",
            "source": "1gan4ny"
          }
        },
        "city": {
          "label": {
            "text": "Ville",
            "source": "142k4ma"
          }
        },
        "grid": {
          "label": {
            "text": "Contact",
            "source": "w3fq2r"
          }
        },
        "email": {
          "label": {
            "text": "Courriel",
            "source": "inbfc7"
          }
        },
        "phone": {
          "label": {
            "text": "Téléphone",
            "source": "kb2lhr"
          }
        },
        "panel": {
          "label": {
            "text": "Emploi",
            "source": "1eqehn7"
          }
        },
        "employer": {
          "label": {
            "text": "Employeur",
            "source": "1b4q7j8"
          }
        },
        "tabs": {
          "tabs": {
            "tab_1": {
              "label": {
                "text": "Personnel",
                "source": "umaizx"
              }
            },
            "tab_2": {
              "label": {
                "text": "Travail",
                "source": "1oz7yps"
              }
            }
          }
        },
        "nickname": {
          "label": {
            "text": "Surnom",
            "source": "1qv15nx"
          }
        },
        "jobTitle": {
          "label": {
            "text": "Titre du poste",
            "source": "1xobnj6"
          }
        },
        "step_1": {
          "label": {
            "text": "Admissibilité",
            "source": "v1y4j2"
          }
        },
        "resident": {
          "label": {
            "text": "Je suis résident",
            "source": "1xxyuy3"
          }
        },
        "step_2": {
          "label": {
            "text": "Révision",
            "source": "tnr3lt"
          }
        },
        "notes": {
          "label": {
            "text": "Notes",
            "source": "4f76ga"
          }
        },
        "container": {
          "label": {
            "text": "Consentement",
            "source": "1yfs0gt"
          }
        },
        "consent": {
          "label": {
            "text": "Me contacter au sujet de ma demande",
            "source": "j0nvge"
          }
        },
        "submit": {
          "label": {
            "text": "Soumettre",
            "source": "hvztxh"
          }
        },
        "buttonSecondary": {
          "label": {
            "text": "Enregistrer pour plus tard",
            "source": "1ni5qg9"
          }
        },
        "buttonSuccess": {
          "label": {
            "text": "Approuver",
            "source": "1s2ov2y"
          }
        },
        "buttonDanger": {
          "label": {
            "text": "Supprimer",
            "source": "oay2cq"
          }
        },
        "buttonWarning": {
          "label": {
            "text": "Signaler",
            "source": "h872lz"
          }
        },
        "buttonInfo": {
          "label": {
            "text": "En savoir plus",
            "source": "1n4iqey"
          }
        },
        "buttonLight": {
          "label": {
            "text": "Annuler",
            "source": "ew9em3"
          }
        },
        "buttonDark": {
          "label": {
            "text": "Archiver",
            "source": "w0suw5"
          }
        },
        "buttonLink": {
          "label": {
            "text": "Passer",
            "source": "1hpqu3m"
          }
        },
        "buttonSmall": {
          "label": {
            "text": "Réinitialiser",
            "source": "2zps2o"
          }
        }
      }
    }
  }
} as FormDefinition;
