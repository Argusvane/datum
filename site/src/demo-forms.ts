/**
 * The forms the home page's live demo offers, from the simplest to the most involved, so a
 * visitor can see how far the definition goes: fields and validation, rules and calculations,
 * containers (a grid, tabs, a panel), file uploads, a multi-step form with a budget that adds
 * itself up, and a journey that asks its questions a page at a time, branching on the answers,
 * beside a one-page journey of the same form.
 * Data, not copy, so it lives beside pillars.ts rather than in it. Typed
 * `unknown`: the site has no engine types, and the elements take the object as it is.
 *
 * Every form is bilingual (en, fr-CA), so the language switcher has something to switch.
 */
export interface DemoExample {
  id: string;
  /** The picker's label. */
  label: string;
  definition: unknown;
  /**
   * The page's own wording for the form (`<datum-form>`'s `texts`), where the example words
   * something the engine would otherwise say in its own English — the error summary's heading.
   */
  texts?: Record<string, unknown>;
}

/** A localized text: English by default, French for fr-CA. */
function t(en: string, fr: string): { default: string; locales: { "fr-CA": string } } {
  return { default: en, locales: { "fr-CA": fr } };
}

const EMAIL = "[^@\\s]+@[^@\\s]+\\.[^@\\s]+";

const localization = {
  defaultLocale: "en",
  supportedLocales: [
    { code: "en", label: "English" },
    { code: "fr-CA", label: "Français" }
  ]
};

const submitButton = (id: string, label: string) => ({
  id,
  type: "button",
  configuration: { label, action: "submit" }
});

/** 1. Two fields and a button: the least a form can be. */
const newsletter = {
  id: "newsletter",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Stay in the loop",
      description: "One email a month. Unsubscribe any time."
    },
    children: {
      content: [
        {
          id: "email",
          type: "text",
          configuration: {
            label: "Email",
            required: true,
            pattern: EMAIL,
            messages: {
              required: "Enter your email address.",
              pattern: "Enter an email address."
            }
          }
        },
        {
          id: "consent",
          type: "checkbox",
          configuration: {
            label: "I agree to receive the newsletter",
            required: true,
            messages: { required: "Tick the box to subscribe." }
          }
        },
        submitButton("subscribe", "Subscribe")
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Restez informé",
          "source": "bjv0cy"
        },
        "description": {
          "text": "Un courriel par mois. Désabonnez-vous quand vous voulez.",
          "source": "h84at6"
        }
      },
      "components": {
        "email": {
          "label": {
            "text": "Courriel",
            "source": "inbfc7"
          },
          "messages": {
            "required": {
              "text": "Entrez votre adresse courriel.",
              "source": "yr7u3a"
            },
            "pattern": {
              "text": "Entrez une adresse courriel.",
              "source": "smays6"
            }
          }
        },
        "consent": {
          "label": {
            "text": "J'accepte de recevoir l'infolettre",
            "source": "4ulo02"
          },
          "messages": {
            "required": {
              "text": "Cochez la case pour vous abonner.",
              "source": "1krnzer"
            }
          }
        },
        "subscribe": {
          "label": {
            "text": "S'abonner",
            "source": "45v37"
          }
        }
      }
    }
  }
};

/** 2. A default, a choice, a field that appears on a tick, a limit: the everyday form. */
const callback = {
  id: "site-demo",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Request a callback",
      description: "Tell us how to reach you and we will call within two business days.",
      messages: {
        maxLength: "Keep it under {maxLength} characters."
      }
    },
    children: {
      content: [
        {
          id: "fullName",
          type: "text",
          configuration: {
            label: "Full name",
            description: "As it appears on your identification",
            required: true,
            messages: { required: "Enter your full name." }
          }
        },
        {
          id: "contactMethod",
          type: "radio",
          configuration: {
            label: "How should we reach you?",
            options: [
              { value: "email", label: "Email" },
              { value: "phone", label: "Phone" }
            ]
          },
          // A default, so the Data tab has an answer to show before anyone types.
          rules: { defaultValue: '"email"' }
        },
        {
          id: "subscribe",
          type: "checkbox",
          configuration: { label: "Send me the newsletter" }
        },
        {
          id: "newsletterEmail",
          type: "text",
          configuration: {
            label: "Newsletter email",
            pattern: EMAIL,
            messages: { pattern: "Enter an email address." }
          },
          rules: { visibleWhen: "subscribe" }
        },
        {
          id: "notes",
          type: "textarea",
          configuration: { label: "Anything we should know?", maxLength: 300 }
        },
        submitButton("submit", "Send")
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Demander un rappel",
          "source": "1hz6788"
        },
        "description": {
          "text": "Dites-nous comment vous joindre et nous vous rappellerons dans les deux jours ouvrables.",
          "source": "t045ke"
        },
        "messages": {
          "maxLength": {
            "text": "Au plus {maxLength} caractères.",
            "source": "7cdk7t"
          }
        }
      },
      "components": {
        "fullName": {
          "label": {
            "text": "Nom complet",
            "source": "13z0t9r"
          },
          "description": {
            "text": "Tel qu'il apparaît sur votre pièce d'identité",
            "source": "1bidw86"
          },
          "messages": {
            "required": {
              "text": "Entrez votre nom complet.",
              "source": "8bi3le"
            }
          }
        },
        "contactMethod": {
          "label": {
            "text": "Comment vous joindre?",
            "source": "1ijdpg1"
          },
          "options": {
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
            }
          }
        },
        "subscribe": {
          "label": {
            "text": "M'envoyer l'infolettre",
            "source": "1x4892n"
          }
        },
        "newsletterEmail": {
          "label": {
            "text": "Courriel pour l'infolettre",
            "source": "fwj2oq"
          },
          "messages": {
            "pattern": {
              "text": "Entrez une adresse courriel.",
              "source": "smays6"
            }
          }
        },
        "notes": {
          "label": {
            "text": "Quelque chose à savoir?",
            "source": "1jxjgx8"
          }
        },
        "submit": {
          "label": {
            "text": "Envoyer",
            "source": "1vatbdb"
          }
        }
      }
    }
  }
};

/** 3. A grid, a fieldset, options, a calculation, a field required only when it applies. */
const registration = {
  id: "workshop-registration",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Register for the workshop",
      description: "Seats are limited to forty. Registration closes on the 30th."
    },
    children: {
      content: [
        {
          id: "attendee",
          type: "fieldset",
          configuration: { label: "Attendee" },
          children: {
            content: [
              {
                id: "name",
                type: "grid",
                configuration: { columns: 2 },
                children: {
                  column_1: [
                    {
                      id: "firstName",
                      type: "text",
                      configuration: { label: "First name", required: true, messages: { required: "Enter your first name." } }
                    }
                  ],
                  column_2: [
                    {
                      id: "lastName",
                      type: "text",
                      configuration: { label: "Last name", required: true, messages: { required: "Enter your last name." } }
                    }
                  ]
                }
              },
              {
                id: "email",
                type: "text",
                configuration: {
                  label: "Email",
                  description: "Your ticket goes here.",
                  required: true,
                  pattern: EMAIL,
                  messages: { required: "Enter your email address.", pattern: "Enter an email address." }
                }
              }
            ]
          }
        },
        {
          id: "session",
          type: "select",
          configuration: {
            label: "Session",
            required: true,
            options: [
              { value: "morning", label: "Morning workshop" },
              { value: "afternoon", label: "Afternoon lab" },
              { value: "full", label: "Full day" }
            ],
            messages: { required: "Pick a session." }
          }
        },
        {
          id: "guests",
          type: "number",
          configuration: { label: "Guests you bring", description: "Up to four.", step: 1, min: 0, max: 4 },
          rules: { defaultValue: "0" }
        },
        {
          id: "total",
          type: "number",
          configuration: { label: "Total", description: "45 per seat, you included.", prefix: "$" },
          // Recomputed from the answers: seats times the price, read-only.
          rules: { value: "sum(guests, 1) * 45", readonlyWhen: "true" }
        },
        {
          id: "dietary",
          type: "checkboxes",
          configuration: {
            label: "Dietary needs",
            options: [
              { value: "vegetarian", label: "Vegetarian" },
              { value: "vegan", label: "Vegan" },
              { value: "gluten", label: "Gluten-free" },
              { value: "other", label: "Other" }
            ]
          }
        },
        {
          id: "dietaryOther",
          type: "text",
          configuration: { label: "Tell us more", messages: { required: "Say what you need." } },
          // Shown, and required, only when "Other" is ticked: a checkbox group's answer is one
          // flag per option, so the rule reads the option's own path.
          rules: { visibleWhen: "dietary.other", requiredWhen: "dietary.other" }
        },
        {
          id: "arrival",
          type: "date",
          configuration: { label: "Arrival date" }
        },
        submitButton("register", "Register")
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Inscription à l'atelier",
          "source": "1k1jp6d"
        },
        "description": {
          "text": "Les places sont limitées à quarante. Les inscriptions ferment le 30.",
          "source": "mg61ev"
        }
      },
      "components": {
        "attendee": {
          "label": {
            "text": "Participant",
            "source": "1h8ydeb"
          }
        },
        "firstName": {
          "label": {
            "text": "Prénom",
            "source": "16fb7ko"
          },
          "messages": {
            "required": {
              "text": "Entrez votre prénom.",
              "source": "14rl3ht"
            }
          }
        },
        "lastName": {
          "label": {
            "text": "Nom",
            "source": "e5j6io"
          },
          "messages": {
            "required": {
              "text": "Entrez votre nom.",
              "source": "1cgkcqb"
            }
          }
        },
        "email": {
          "label": {
            "text": "Courriel",
            "source": "inbfc7"
          },
          "description": {
            "text": "Votre billet sera envoyé ici.",
            "source": "2di0rc"
          },
          "messages": {
            "required": {
              "text": "Entrez votre adresse courriel.",
              "source": "yr7u3a"
            },
            "pattern": {
              "text": "Entrez une adresse courriel.",
              "source": "smays6"
            }
          }
        },
        "session": {
          "label": {
            "text": "Séance",
            "source": "8yh9jr"
          },
          "options": {
            "morning": {
              "label": {
                "text": "Atelier du matin",
                "source": "aobwjo"
              }
            },
            "afternoon": {
              "label": {
                "text": "Laboratoire de l'après-midi",
                "source": "vi75vo"
              }
            },
            "full": {
              "label": {
                "text": "Journée complète",
                "source": "1fr45la"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Choisissez une séance.",
              "source": "1guvtmv"
            }
          }
        },
        "guests": {
          "label": {
            "text": "Invités que vous amenez",
            "source": "1qt885b"
          },
          "description": {
            "text": "Jusqu'à quatre.",
            "source": "mg5pzn"
          }
        },
        "total": {
          "label": {
            "text": "Total",
            "source": "1c0as9p"
          },
          "description": {
            "text": "45 par place, la vôtre comprise.",
            "source": "1bugnof"
          }
        },
        "dietary": {
          "label": {
            "text": "Besoins alimentaires",
            "source": "e73n3q"
          },
          "options": {
            "vegetarian": {
              "label": {
                "text": "Végétarien",
                "source": "1sspwll"
              }
            },
            "vegan": {
              "label": {
                "text": "Végétalien",
                "source": "k19pg2"
              }
            },
            "gluten": {
              "label": {
                "text": "Sans gluten",
                "source": "1gmsd1"
              }
            },
            "other": {
              "label": {
                "text": "Autre",
                "source": "ukzedx"
              }
            }
          }
        },
        "dietaryOther": {
          "label": {
            "text": "Précisez",
            "source": "3pdfoz"
          },
          "messages": {
            "required": {
              "text": "Dites-nous ce qu'il vous faut.",
              "source": "re0uoz"
            }
          }
        },
        "arrival": {
          "label": {
            "text": "Date d'arrivée",
            "source": "11ugrqa"
          }
        },
        "register": {
          "label": {
            "text": "S'inscrire",
            "source": "avtc68"
          }
        }
      }
    }
  }
};

/** 4. Tabs, a panel, a file upload, a character count, a field that depends on a choice. */
const application = {
  id: "job-application",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Apply for the role",
      description: "Three short tabs. We reply to every application within two weeks."
    },
    children: {
      content: [
        {
          id: "sections",
          type: "tabs",
          configuration: {
            tabs: [
              { id: "personal", label: "About you" },
              { id: "experience", label: "Experience" },
              { id: "documents", label: "Documents" }
            ]
          },
          children: {
            personal: [
              {
                id: "fullName",
                type: "text",
                configuration: { label: "Full name", required: true, messages: { required: "Enter your full name." } }
              },
              {
                id: "email",
                type: "text",
                configuration: {
                  label: "Email",
                  required: true,
                  pattern: EMAIL,
                  messages: { required: "Enter your email address.", pattern: "Enter an email address." }
                }
              },
              {
                id: "phone",
                type: "text",
                configuration: {
                  label: "Phone",
                  pattern: "^\\+?[0-9 ()-]{7,}$",
                  messages: { pattern: "Enter a phone number, digits and spaces only." }
                }
              },
              {
                id: "province",
                type: "select",
                configuration: {
                  label: "Where you live",
                  options: [
                    { value: "on", label: "Ontario" },
                    { value: "qc", label: "Quebec" },
                    { value: "bc", label: "British Columbia" },
                    { value: "ab", label: "Alberta" },
                    { value: "other", label: "Elsewhere" }
                  ]
                }
              },
              {
                id: "relocate",
                type: "radio",
                configuration: {
                  label: "The role is in Ottawa. Would you relocate?",
                  options: [
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" }
                  ],
                  messages: { required: "Let us know." }
                },
                // Asked only of someone outside Ontario, and then required.
                rules: { visibleWhen: 'province != "on"', requiredWhen: 'province != "on"' }
              }
            ],
            experience: [
              {
                id: "role",
                type: "select",
                configuration: {
                  label: "Role",
                  required: true,
                  options: [
                    { value: "engineering", label: "Engineering" },
                    { value: "design", label: "Design" },
                    { value: "support", label: "Support" }
                  ],
                  messages: { required: "Pick the role you are applying for." }
                }
              },
              {
                id: "years",
                type: "number",
                configuration: { label: "Years of experience", step: 1, min: 0 }
              },
              {
                id: "portfolio",
                type: "text",
                configuration: {
                  label: "Portfolio",
                  description: "A link to your work.",
                  pattern: "^https?://\\S+$",
                  messages: { required: "Designers, show us your work.", pattern: "Enter a web address starting with http." }
                },
                rules: { visibleWhen: 'role = "design"', requiredWhen: 'role = "design"' }
              },
              {
                id: "summary",
                type: "textarea",
                configuration: {
                  label: "Why you",
                  description: "In your own words.",
                  maxLength: 600,
                  characterCount: true
                }
              },
              {
                id: "references",
                type: "panel",
                configuration: { label: "A reference" },
                children: {
                  content: [
                    { id: "refName", type: "text", configuration: { label: "Name" } },
                    { id: "refContact", type: "text", configuration: { label: "Email or phone" } }
                  ]
                }
              }
            ],
            documents: [
              {
                id: "resume",
                type: "file",
                configuration: {
                  label: "Résumé",
                  description: "PDF, up to 4 MB.",
                  accept: ["application/pdf"],
                  required: true,
                  messages: { required: "Attach your résumé." }
                }
              },
              {
                id: "coverLetter",
                type: "file",
                configuration: { label: "Cover letter", description: "Optional.", accept: ["application/pdf"] }
              },
              {
                id: "accurate",
                type: "checkbox",
                configuration: {
                  label: "The information I gave is accurate",
                  required: true,
                  messages: { required: "Confirm before you apply." }
                }
              }
            ]
          }
        },
        submitButton("apply", "Apply")
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Postuler",
          "source": "1gu3a9"
        },
        "description": {
          "text": "Trois courts onglets. Nous répondons à chaque candidature dans les deux semaines.",
          "source": "iwy5k5"
        }
      },
      "components": {
        "sections": {
          "tabs": {
            "personal": {
              "label": {
                "text": "Vous",
                "source": "1hah3md"
              }
            },
            "experience": {
              "label": {
                "text": "Expérience",
                "source": "1byxumh"
              }
            },
            "documents": {
              "label": {
                "text": "Documents",
                "source": "oz47lx"
              }
            }
          }
        },
        "fullName": {
          "label": {
            "text": "Nom complet",
            "source": "13z0t9r"
          },
          "messages": {
            "required": {
              "text": "Entrez votre nom complet.",
              "source": "8bi3le"
            }
          }
        },
        "email": {
          "label": {
            "text": "Courriel",
            "source": "inbfc7"
          },
          "messages": {
            "required": {
              "text": "Entrez votre adresse courriel.",
              "source": "yr7u3a"
            },
            "pattern": {
              "text": "Entrez une adresse courriel.",
              "source": "smays6"
            }
          }
        },
        "phone": {
          "label": {
            "text": "Téléphone",
            "source": "kb2lhr"
          },
          "messages": {
            "pattern": {
              "text": "Entrez un numéro de téléphone, chiffres et espaces seulement.",
              "source": "17u03uz"
            }
          }
        },
        "province": {
          "label": {
            "text": "Où vous habitez",
            "source": "9h0ryj"
          },
          "options": {
            "on": {
              "label": {
                "text": "Ontario",
                "source": "gv0epj"
              }
            },
            "qc": {
              "label": {
                "text": "Québec",
                "source": "1bk0v7w"
              }
            },
            "bc": {
              "label": {
                "text": "Colombie-Britannique",
                "source": "y28c38"
              }
            },
            "ab": {
              "label": {
                "text": "Alberta",
                "source": "melfui"
              }
            },
            "other": {
              "label": {
                "text": "Ailleurs",
                "source": "17lkkrv"
              }
            }
          }
        },
        "relocate": {
          "label": {
            "text": "Le poste est à Ottawa. Déménageriez-vous?",
            "source": "zcp0tn"
          },
          "options": {
            "yes": {
              "label": {
                "text": "Oui",
                "source": "1dudzcg"
              }
            },
            "no": {
              "label": {
                "text": "Non",
                "source": "r5wqai"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Dites-le-nous.",
              "source": "1r7rbsh"
            }
          }
        },
        "role": {
          "label": {
            "text": "Poste",
            "source": "1402mgp"
          },
          "options": {
            "engineering": {
              "label": {
                "text": "Ingénierie",
                "source": "zbthlc"
              }
            },
            "design": {
              "label": {
                "text": "Conception",
                "source": "1sivvfz"
              }
            },
            "support": {
              "label": {
                "text": "Soutien",
                "source": "txsyvc"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Choisissez le poste visé.",
              "source": "m8w203"
            }
          }
        },
        "years": {
          "label": {
            "text": "Années d'expérience",
            "source": "1ft63ye"
          }
        },
        "portfolio": {
          "label": {
            "text": "Portfolio",
            "source": "1po5d37"
          },
          "description": {
            "text": "Un lien vers votre travail.",
            "source": "kfz74t"
          },
          "messages": {
            "required": {
              "text": "Designers, montrez-nous votre travail.",
              "source": "iv091u"
            },
            "pattern": {
              "text": "Entrez une adresse web commençant par http.",
              "source": "x4g7y6"
            }
          }
        },
        "summary": {
          "label": {
            "text": "Pourquoi vous",
            "source": "11cr5fe"
          },
          "description": {
            "text": "Dans vos mots.",
            "source": "1d4uase"
          }
        },
        "references": {
          "label": {
            "text": "Une référence",
            "source": "1ypgud5"
          }
        },
        "refName": {
          "label": {
            "text": "Nom",
            "source": "4el6o6"
          }
        },
        "refContact": {
          "label": {
            "text": "Courriel ou téléphone",
            "source": "6myb60"
          }
        },
        "resume": {
          "label": {
            "text": "Curriculum vitæ",
            "source": "vvv8cq"
          },
          "description": {
            "text": "PDF, jusqu'à 4 Mo.",
            "source": "30eg9u"
          },
          "messages": {
            "required": {
              "text": "Joignez votre curriculum vitæ.",
              "source": "o8oabw"
            }
          }
        },
        "coverLetter": {
          "label": {
            "text": "Lettre de présentation",
            "source": "i2n1s0"
          },
          "description": {
            "text": "Facultative.",
            "source": "1jcssd1"
          }
        },
        "accurate": {
          "label": {
            "text": "Les renseignements fournis sont exacts",
            "source": "1w6lbdo"
          },
          "messages": {
            "required": {
              "text": "Confirmez avant de postuler.",
              "source": "2jy8th"
            }
          }
        },
        "apply": {
          "label": {
            "text": "Postuler",
            "source": "1k6e5zv"
          }
        }
      }
    }
  }
};

/** 5. Steps, a budget that adds itself up, a warning that appears when the numbers disagree, a declaration. */
const grant = {
  id: "community-grant",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Community grant application",
      description: "Four steps. Your answers are kept as you go."
    },
    children: {
      content: [
        {
          id: "steps",
          type: "steps",
          configuration: {},
          children: {
            content: [
              {
                id: "organization",
                type: "step",
                configuration: { label: "Organization" },
                children: {
                  content: [
                    {
                      id: "orgName",
                      type: "text",
                      configuration: { label: "Organization name", required: true, messages: { required: "Enter the organization's name." } }
                    },
                    {
                      id: "orgType",
                      type: "select",
                      configuration: {
                        label: "Type",
                        required: true,
                        options: [
                          { value: "nonprofit", label: "Registered charity" },
                          { value: "municipality", label: "Municipality" },
                          { value: "coop", label: "Cooperative" },
                          { value: "other", label: "Other" }
                        ],
                        messages: { required: "Pick the type of organization." }
                      }
                    },
                    {
                      id: "charityNumber",
                      type: "text",
                      configuration: {
                        label: "Charity registration number",
                        description: "Nine digits, RR, four digits.",
                        pattern: "^[0-9]{9}RR[0-9]{4}$",
                        messages: { required: "Enter the registration number.", pattern: "Enter it as 123456789RR0001." }
                      },
                      rules: { visibleWhen: 'orgType = "nonprofit"', requiredWhen: 'orgType = "nonprofit"' }
                    },
                    {
                      id: "orgTypeOther",
                      type: "text",
                      configuration: { label: "Which type?", messages: { required: "Tell us the type." } },
                      rules: { visibleWhen: 'orgType = "other"', requiredWhen: 'orgType = "other"' }
                    },
                    { id: "founded", type: "date", configuration: { label: "Founded" } }
                  ]
                }
              },
              {
                id: "project",
                type: "step",
                configuration: { label: "Project" },
                children: {
                  content: [
                    {
                      id: "projectTitle",
                      type: "text",
                      configuration: { label: "Project title", required: true, maxLength: 80, characterCount: true, messages: { required: "Give the project a title." } }
                    },
                    {
                      id: "summary",
                      type: "textarea",
                      configuration: {
                        label: "What will you do?",
                        description: "Who it serves, what changes, how you will know.",
                        required: true,
                        maxLength: 500,
                        characterCount: true,
                        messages: { required: "Describe the project." }
                      }
                    },
                    {
                      id: "dates",
                      type: "grid",
                      configuration: { columns: 2 },
                      children: {
                        column_1: [{ id: "start", type: "date", configuration: { label: "Start", required: true, messages: { required: "Enter the start date." } } }],
                        column_2: [{ id: "end", type: "date", configuration: { label: "End", required: true, messages: { required: "Enter the end date." } } }]
                      }
                    },
                    {
                      id: "dateOrder",
                      type: "html",
                      configuration: {
                        content: "<p><strong>The project ends before it starts.</strong> Check the two dates.</p>"
                      },
                      // A date test: both days given, and the end is the earlier one.
                      rules: { visibleWhen: "not(empty(start)) and not(empty(end)) and end < start" }
                    },
                    {
                      id: "themes",
                      type: "checkboxes",
                      configuration: {
                        label: "Themes",
                        description: "Every one that applies.",
                        options: [
                          { value: "housing", label: "Housing" },
                          { value: "climate", label: "Climate" },
                          { value: "youth", label: "Youth" },
                          { value: "accessibility", label: "Accessibility" }
                        ]
                      }
                    }
                  ]
                }
              },
              {
                id: "budget",
                type: "step",
                configuration: { label: "Budget" },
                children: {
                  content: [
                    {
                      id: "lines",
                      type: "grid",
                      configuration: { columns: 2 },
                      children: {
                        column_1: [
                          { id: "staff", type: "number", configuration: { label: "Staff", prefix: "$", step: 1, min: 0 } },
                          { id: "equipment", type: "number", configuration: { label: "Equipment", prefix: "$", step: 1, min: 0 } }
                        ],
                        column_2: [
                          { id: "travel", type: "number", configuration: { label: "Travel", prefix: "$", step: 1, min: 0 } },
                          { id: "otherCosts", type: "number", configuration: { label: "Other", prefix: "$", step: 1, min: 0 } }
                        ]
                      }
                    },
                    {
                      id: "total",
                      type: "number",
                      configuration: { label: "Total budget", prefix: "$" },
                      rules: { value: "sum(staff, equipment, travel, otherCosts)", readonlyWhen: "true" }
                    },
                    {
                      id: "contribution",
                      type: "number",
                      configuration: { label: "Your contribution", description: "A quarter of the total, a fifth once the budget passes $50,000.", prefix: "$" },
                      rules: { value: "if total > 50000 then total * 0.2 else total * 0.25", readonlyWhen: "true" }
                    },
                    {
                      id: "requested",
                      type: "number",
                      configuration: { label: "Amount requested", prefix: "$", step: 1, min: 0, required: true, messages: { required: "Enter the amount you are asking for." } }
                    },
                    {
                      id: "overBudget",
                      type: "html",
                      configuration: {
                        content: "<p><strong>The amount requested is more than the whole budget.</strong> Lower it, or revise the lines above.</p>"
                      },
                      // A warning that exists only while the numbers disagree.
                      rules: { visibleWhen: "not(empty(requested)) and requested > total" }
                    }
                  ]
                }
              },
              {
                id: "declaration",
                type: "step",
                configuration: { label: "Declaration" },
                children: {
                  content: [
                    {
                      id: "accurate",
                      type: "checkbox",
                      configuration: { label: "The information in this application is complete and accurate", required: true, messages: { required: "Confirm the declaration." } }
                    },
                    {
                      id: "terms",
                      type: "checkbox",
                      configuration: { label: "I have read the funding terms", required: true, messages: { required: "Confirm you have read the terms." } }
                    },
                    {
                      id: "signatory",
                      type: "text",
                      configuration: { label: "Signed by", description: "Name and title.", required: true, messages: { required: "Enter the signatory's name." } }
                    },
                    { id: "signedOn", type: "date", configuration: { label: "Date", required: true, messages: { required: "Enter the date." } } },
                    submitButton("submitApplication", "Submit application")
                  ]
                }
              }
            ]
          }
        }
      ]
    }
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Demande de subvention communautaire",
          "source": "jzqffa"
        },
        "description": {
          "text": "Quatre étapes. Vos réponses sont conservées au fil de la saisie.",
          "source": "x2kent"
        }
      },
      "components": {
        "organization": {
          "label": {
            "text": "Organisme",
            "source": "725tl6"
          }
        },
        "orgName": {
          "label": {
            "text": "Nom de l'organisme",
            "source": "1xv6u7x"
          },
          "messages": {
            "required": {
              "text": "Entrez le nom de l'organisme.",
              "source": "nlxeoc"
            }
          }
        },
        "orgType": {
          "label": {
            "text": "Type",
            "source": "1m2zofh"
          },
          "options": {
            "nonprofit": {
              "label": {
                "text": "Organisme de bienfaisance enregistré",
                "source": "uz2l8t"
              }
            },
            "municipality": {
              "label": {
                "text": "Municipalité",
                "source": "i5b8t9"
              }
            },
            "coop": {
              "label": {
                "text": "Coopérative",
                "source": "16qob3s"
              }
            },
            "other": {
              "label": {
                "text": "Autre",
                "source": "ukzedx"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Choisissez le type d'organisme.",
              "source": "e5lx3l"
            }
          }
        },
        "charityNumber": {
          "label": {
            "text": "Numéro d'enregistrement",
            "source": "fi60fp"
          },
          "description": {
            "text": "Neuf chiffres, RR, quatre chiffres.",
            "source": "59ssip"
          },
          "messages": {
            "required": {
              "text": "Entrez le numéro d'enregistrement.",
              "source": "1fh5ywi"
            },
            "pattern": {
              "text": "Entrez-le sous la forme 123456789RR0001.",
              "source": "lnlas"
            }
          }
        },
        "orgTypeOther": {
          "label": {
            "text": "Quel type?",
            "source": "hbozcb"
          },
          "messages": {
            "required": {
              "text": "Précisez le type.",
              "source": "aa71vr"
            }
          }
        },
        "founded": {
          "label": {
            "text": "Fondé le",
            "source": "1laj472"
          }
        },
        "project": {
          "label": {
            "text": "Projet",
            "source": "y8csbi"
          }
        },
        "projectTitle": {
          "label": {
            "text": "Titre du projet",
            "source": "ctfj8s"
          },
          "messages": {
            "required": {
              "text": "Donnez un titre au projet.",
              "source": "1rnabnb"
            }
          }
        },
        "summary": {
          "label": {
            "text": "Que ferez-vous?",
            "source": "g2tm6w"
          },
          "description": {
            "text": "Qui en bénéficie, ce qui change, comment vous le saurez.",
            "source": "1u8by7j"
          },
          "messages": {
            "required": {
              "text": "Décrivez le projet.",
              "source": "1syyqis"
            }
          }
        },
        "start": {
          "label": {
            "text": "Début",
            "source": "30xvgf"
          },
          "messages": {
            "required": {
              "text": "Entrez la date de début.",
              "source": "13rcqg"
            }
          }
        },
        "end": {
          "label": {
            "text": "Fin",
            "source": "1llf32i"
          },
          "messages": {
            "required": {
              "text": "Entrez la date de fin.",
              "source": "1amcu7l"
            }
          }
        },
        "dateOrder": {
          "content": {
            "text": "<p><strong>Le projet se termine avant de commencer.</strong> Vérifiez les deux dates.</p>",
            "source": "1b6hst6"
          }
        },
        "themes": {
          "label": {
            "text": "Thèmes",
            "source": "1h2ekoj"
          },
          "description": {
            "text": "Tous ceux qui s'appliquent.",
            "source": "kifzwt"
          },
          "options": {
            "housing": {
              "label": {
                "text": "Logement",
                "source": "1e45r30"
              }
            },
            "climate": {
              "label": {
                "text": "Climat",
                "source": "1w09184"
              }
            },
            "youth": {
              "label": {
                "text": "Jeunesse",
                "source": "bz16s0"
              }
            },
            "accessibility": {
              "label": {
                "text": "Accessibilité",
                "source": "10tizdr"
              }
            }
          }
        },
        "budget": {
          "label": {
            "text": "Budget",
            "source": "auevmw"
          }
        },
        "staff": {
          "label": {
            "text": "Personnel",
            "source": "3murn5"
          }
        },
        "equipment": {
          "label": {
            "text": "Équipement",
            "source": "1xtq0ev"
          }
        },
        "travel": {
          "label": {
            "text": "Déplacements",
            "source": "cc2ec9"
          }
        },
        "otherCosts": {
          "label": {
            "text": "Autres",
            "source": "ukzedx"
          }
        },
        "total": {
          "label": {
            "text": "Budget total",
            "source": "du9b6i"
          }
        },
        "contribution": {
          "label": {
            "text": "Votre contribution",
            "source": "1oz9kfo"
          },
          "description": {
            "text": "Le quart du total, le cinquième au-delà de 50 000 $.",
            "source": "h0lv0f"
          }
        },
        "requested": {
          "label": {
            "text": "Montant demandé",
            "source": "avxtad"
          },
          "messages": {
            "required": {
              "text": "Entrez le montant demandé.",
              "source": "wwkdd"
            }
          }
        },
        "overBudget": {
          "content": {
            "text": "<p><strong>Le montant demandé dépasse le budget total.</strong> Réduisez-le, ou revoyez les postes ci-dessus.</p>",
            "source": "8vs029"
          }
        },
        "declaration": {
          "label": {
            "text": "Déclaration",
            "source": "13b36fn"
          }
        },
        "accurate": {
          "label": {
            "text": "Les renseignements de cette demande sont complets et exacts",
            "source": "101vb87"
          },
          "messages": {
            "required": {
              "text": "Confirmez la déclaration.",
              "source": "1k5x7qa"
            }
          }
        },
        "terms": {
          "label": {
            "text": "J'ai lu les conditions de financement",
            "source": "u22abz"
          },
          "messages": {
            "required": {
              "text": "Confirmez avoir lu les conditions.",
              "source": "ltj700"
            }
          }
        },
        "signatory": {
          "label": {
            "text": "Signé par",
            "source": "13bof56"
          },
          "description": {
            "text": "Nom et titre.",
            "source": "68n7qp"
          },
          "messages": {
            "required": {
              "text": "Entrez le nom du signataire.",
              "source": "4urzlz"
            }
          }
        },
        "signedOn": {
          "label": {
            "text": "Date",
            "source": "ggjuyh"
          },
          "messages": {
            "required": {
              "text": "Entrez la date.",
              "source": "qqs7dw"
            }
          }
        },
        "submitApplication": {
          "label": {
            "text": "Soumettre la demande",
            "source": "tzqxj"
          }
        }
      }
    }
  }
};

/**
 * 6. A journey over one form: the questions are written once, as the form, and the journey
 * asks them a page at a time. Renters get a page owners never see, and someone asking about a
 * home they do not live in is stopped on an exit page with no Submit. The landlord's fields are
 * required, yet an owner's answers submit without them: they show only for a renter, and a page
 * off the path is never checked.
 *
 * Two presentations fill the one form. The journey asks a few things its own way: the cost as
 * two amounts of its own that it adds up into the form's "Estimated cost" (a worked-out value),
 * and the email under a label of its own (an alias: its answer is the form's email). Its own
 * amounts stay in the browser; only the total is sent. "Quick apply" is a journey of one page:
 * every question on it, the form's own fields as they are, its page heading hidden so it looks
 * like the form. Each asks every field the form
 * requires, so either one submits the same record.
 */
const rebate = {
  id: "energy-rebate",
  version: "1.0.0",
  schemaVersion: "1",
  localization,
  root: {
    id: "root",
    type: "form",
    configuration: {
      title: "Home energy rebate",
      description: "A few questions, one page at a time, to see whether you can apply."
    },
    children: {
      content: [
        {
          id: "mainHome",
          type: "radio",
          configuration: {
            label: "Do you live in this home most of the year?",
            required: true,
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" }
            ],
            messages: { required: "Tell us whether you live there." }
          }
        },
        {
          id: "tenure",
          type: "radio",
          configuration: {
            label: "Do you own the home or rent it?",
            required: true,
            options: [
              { value: "own", label: "I own it" },
              { value: "rent", label: "I rent it" }
            ],
            messages: { required: "Tell us whether you own or rent." }
          }
        },
        // A renter's questions: shown, and so required, only for a renter, wherever they are asked
        // (the whole form, the one-page journey, the journey's landlord page).
        {
          id: "landlordName",
          type: "text",
          configuration: {
            label: "Landlord's name",
            required: true,
            messages: { required: "Enter your landlord's name." }
          },
          rules: { visibleWhen: 'tenure = "rent"' }
        },
        {
          id: "landlordConsent",
          type: "checkbox",
          configuration: {
            label: "My landlord agrees to the work",
            required: true,
            messages: { required: "Your landlord must agree before you apply." }
          },
          rules: { visibleWhen: 'tenure = "rent"' }
        },
        {
          id: "upgrade",
          type: "select",
          configuration: {
            label: "What will you upgrade?",
            required: true,
            options: [
              { value: "heatPump", label: "A heat pump" },
              { value: "insulation", label: "Insulation" },
              { value: "windows", label: "Windows and doors" }
            ],
            messages: { required: "Pick the upgrade." }
          }
        },
        {
          id: "cost",
          type: "number",
          configuration: {
            label: "Estimated cost",
            prefix: "$",
            step: 1,
            min: 0,
            required: true,
            messages: { required: "Enter the estimated cost." }
          }
        },
        {
          id: "rebateAmount",
          type: "number",
          configuration: {
            label: "Your rebate",
            description: "A quarter of the cost, up to $5,000.",
            prefix: "$"
          },
          rules: { value: "min(round(sum(cost) * 0.25), 5000)", readonlyWhen: "true" }
        },
        {
          id: "fullName",
          type: "text",
          configuration: { label: "Full name", required: true, messages: { required: "Enter your full name." } }
        },
        {
          id: "email",
          type: "text",
          configuration: {
            label: "Email",
            required: true,
            pattern: EMAIL,
            messages: { required: "Enter your email address.", pattern: "Enter an email address." }
          }
        },
        {
          id: "notEligibleNote",
          type: "html",
          configuration: {
            content: "<p>The rebate is for the home you live in most of the year. If you answered by mistake, go back and change your answer.</p>"
          },
          // The exit page's text. Shown only where it applies, so the whole form (the builder's
          // canvas) reads right too.
          rules: { visibleWhen: 'mainHome = "no"' }
        },
        submitButton("apply", "Apply for the rebate")
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "eligibility",
        name: "Check and apply",
        // "Step 2 of 4" over each heading; the count grows when renting adds the landlord's page.
        progress: "count",
        // The default-language wording; the French is under `translations` at
        // journeys › eligibility › texts.
        texts: {
          back: "Back",
          continue: "Continue",
          pageOf: "Step {{n}} of {{total}}"
        },
        pages: [
          {
            id: "home",
            title: "Your home",
            components: ["mainHome"],
            // Not the home they live in: straight to the exit page.
            routes: [{ when: 'mainHome = "no"', to: "ineligible" }]
          },
          {
            id: "ownership",
            title: "Owning or renting",
            components: ["tenure"],
            // Only a renter goes on to the landlord's page; everyone else passes it by.
            routes: [{ when: 'not(tenure = "rent")', to: "work" }]
          },
          {
            id: "landlord",
            title: "Your landlord",
            description: "Renters need their landlord's agreement.",
            components: ["landlordName", "landlordConsent"]
          },
          {
            id: "work",
            title: "The work",
            components: [
              "upgrade",
              // Two amounts of the journey's own: kept in the browser, never sent.
              {
                id: "equipment",
                type: "number",
                configuration: {
                  label: "Equipment and materials",
                  prefix: "$",
                  step: 1,
                  min: 0,
                  required: true,
                  messages: { required: "Enter the cost of the equipment and materials." }
                }
              },
              {
                id: "installation",
                type: "number",
                configuration: {
                  label: "Installation",
                  description: "Leave it empty if you install it yourself.",
                  prefix: "$",
                  step: 1,
                  min: 0
                }
              },
              // A worked-out value: the form's "Estimated cost", added up from the two amounts
              // above and shown read-only. The rebate under it is the form's own calculation.
              { id: "costTotal", type: "journey-value", configuration: { to: "cost", value: "sum(equipment, installation)" } },
              "rebateAmount"
            ]
          },
          {
            id: "contact",
            title: "How to reach you",
            components: [
              "fullName",
              // An alias: a label of the journey's own over the form's email, which it fills.
              {
                id: "decisionEmail",
                type: "text",
                configuration: {
                  label: "Where should we send the decision?",
                  description: "Your email address. We write once your rebate is decided.",
                  fills: "email"
                }
              },
              // The form's own submit button, so the last page says "Apply for the rebate".
              "apply"
            ],
            // The end: the exit page after it is reached only by the route above.
            routes: [{ to: "$end" }]
          },
          {
            id: "ineligible",
            kind: "exit",
            title: "You cannot apply for this rebate",
            components: ["notEligibleNote"]
          }
        ]
      },
      {
        // One page and no routes, the form's own fields as they are, its page heading hidden.
        id: "quick",
        name: "Quick apply",
        heading: "hidden",
        pages: [
          {
            id: "everything",
            title: "Apply for the rebate",
            description: "Every question on one page.",
            components: [
              "mainHome",
              "notEligibleNote",
              "tenure",
              "landlordName",
              "landlordConsent",
              "upgrade",
              "cost",
              "rebateAmount",
              "fullName",
              "email",
              "apply"
            ]
          }
        ]
      }
    ]
  },
  translations: {
    "fr-CA": {
      "form": {
        "title": {
          "text": "Remise pour l'efficacité énergétique domiciliaire",
          "source": "k5dqe9"
        },
        "description": {
          "text": "Quelques questions, une page à la fois, pour savoir si vous pouvez faire une demande.",
          "source": "18t2rpl"
        }
      },
      "components": {
        "mainHome": {
          "label": {
            "text": "Habitez-vous ce logement la majeure partie de l'année?",
            "source": "1xc4zmo"
          },
          "options": {
            "yes": {
              "label": {
                "text": "Oui",
                "source": "1dudzcg"
              }
            },
            "no": {
              "label": {
                "text": "Non",
                "source": "r5wqai"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Dites-nous si vous y habitez.",
              "source": "1ei2cze"
            }
          }
        },
        "tenure": {
          "label": {
            "text": "Êtes-vous propriétaire ou locataire du logement?",
            "source": "1648do9"
          },
          "options": {
            "own": {
              "label": {
                "text": "J'en suis propriétaire",
                "source": "1wry3fd"
              }
            },
            "rent": {
              "label": {
                "text": "Je suis locataire",
                "source": "1p6csyo"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Dites-nous si vous êtes propriétaire ou locataire.",
              "source": "1cs73ym"
            }
          }
        },
        "landlordName": {
          "label": {
            "text": "Nom du propriétaire",
            "source": "1sey8jw"
          },
          "messages": {
            "required": {
              "text": "Entrez le nom de votre propriétaire.",
              "source": "1glrylj"
            }
          }
        },
        "landlordConsent": {
          "label": {
            "text": "Mon propriétaire consent aux travaux",
            "source": "93oa9j"
          },
          "messages": {
            "required": {
              "text": "Votre propriétaire doit consentir avant votre demande.",
              "source": "1kgq1jb"
            }
          }
        },
        "upgrade": {
          "label": {
            "text": "Quels travaux prévoyez-vous?",
            "source": "1vt7ycv"
          },
          "options": {
            "heatPump": {
              "label": {
                "text": "Une thermopompe",
                "source": "1ghidw4"
              }
            },
            "insulation": {
              "label": {
                "text": "L'isolation",
                "source": "1kyo5e7"
              }
            },
            "windows": {
              "label": {
                "text": "Les portes et fenêtres",
                "source": "e6rcxa"
              }
            }
          },
          "messages": {
            "required": {
              "text": "Choisissez les travaux.",
              "source": "5ocrfb"
            }
          }
        },
        "cost": {
          "label": {
            "text": "Coût estimatif",
            "source": "3k0k36"
          },
          "messages": {
            "required": {
              "text": "Entrez le coût estimatif.",
              "source": "fg8qx9"
            }
          }
        },
        "rebateAmount": {
          "label": {
            "text": "Votre remise",
            "source": "1vzxx7t"
          },
          "description": {
            "text": "Le quart du coût, jusqu'à 5 000 $.",
            "source": "1dezgl8"
          }
        },
        "fullName": {
          "label": {
            "text": "Nom complet",
            "source": "13z0t9r"
          },
          "messages": {
            "required": {
              "text": "Entrez votre nom complet.",
              "source": "8bi3le"
            }
          }
        },
        "email": {
          "label": {
            "text": "Courriel",
            "source": "inbfc7"
          },
          "messages": {
            "required": {
              "text": "Entrez votre adresse courriel.",
              "source": "yr7u3a"
            },
            "pattern": {
              "text": "Entrez une adresse courriel.",
              "source": "smays6"
            }
          }
        },
        "notEligibleNote": {
          "content": {
            "text": "<p>La remise vise le logement que vous habitez la majeure partie de l'année. Si vous avez répondu par erreur, revenez en arrière pour changer votre réponse.</p>",
            "source": "163zi78"
          }
        },
        "apply": {
          "label": {
            "text": "Demander la remise",
            "source": "19iivca"
          }
        },
        "equipment": {
          "label": {
            "text": "Équipement et matériaux",
            "source": "1rjfhvw"
          },
          "messages": {
            "required": {
              "text": "Entrez le coût de l'équipement et des matériaux.",
              "source": "1k40sk2"
            }
          }
        },
        "installation": {
          "label": {
            "text": "Installation",
            "source": "lbh0zx"
          },
          "description": {
            "text": "Laissez vide si vous l'installez vous-même.",
            "source": "1wibc2l"
          }
        },
        "decisionEmail": {
          "label": {
            "text": "Où devons-nous envoyer la décision?",
            "source": "16tub9h"
          },
          "description": {
            "text": "Votre adresse courriel. Nous vous écrivons une fois la remise décidée.",
            "source": "1jdl3nw"
          }
        }
      },
      "journeys": {
        "eligibility": {
          "name": {
            "text": "Vérifier et demander",
            "source": "1rb5hru"
          },
          "texts": {
            "back": {
              "text": "Retour",
              "source": "1hzmxtu"
            },
            "continue": {
              "text": "Continuer",
              "source": "1bipuuc"
            },
            "pageOf": {
              "text": "Étape {{n}} de {{total}}",
              "source": "on1ejs"
            }
          },
          "pages": {
            "home": {
              "title": {
                "text": "Votre logement",
                "source": "1og38j5"
              }
            },
            "ownership": {
              "title": {
                "text": "Propriétaire ou locataire",
                "source": "17rim5z"
              }
            },
            "landlord": {
              "title": {
                "text": "Votre propriétaire",
                "source": "rmg7ho"
              },
              "description": {
                "text": "Les locataires ont besoin du consentement de leur propriétaire.",
                "source": "1egw13g"
              }
            },
            "work": {
              "title": {
                "text": "Les travaux",
                "source": "1kcwrtt"
              }
            },
            "contact": {
              "title": {
                "text": "Pour vous joindre",
                "source": "1655ose"
              }
            },
            "ineligible": {
              "title": {
                "text": "Vous ne pouvez pas demander cette remise",
                "source": "jkq8l3"
              }
            }
          }
        },
        "quick": {
          "name": {
            "text": "Demande rapide",
            "source": "ae06t4"
          },
          "pages": {
            "everything": {
              "title": {
                "text": "Demander la remise",
                "source": "19iivca"
              },
              "description": {
                "text": "Toutes les questions sur une seule page.",
                "source": "qgolca"
              }
            }
          }
        }
      }
    }
  }
};

/** In the order the picker lists them: simplest first. */
export const examples: DemoExample[] = [
  { id: "newsletter", label: "1. Newsletter sign-up", definition: newsletter },
  { id: "callback", label: "2. Callback request", definition: callback },
  { id: "registration", label: "3. Workshop registration", definition: registration },
  { id: "application", label: "4. Job application", definition: application },
  { id: "grant", label: "5. Grant application", definition: grant },
  {
    id: "rebate",
    label: "6. Energy rebate, two ways",
    definition: rebate,
    // The summary over a page's errors, worded as the packages/datum journey demo words it,
    // rather than the engine's "1 error(s)"; and the line under the worked-out cost, in French
    // too (the engine words it in English only).
    texts: {
      summaryHeading: t("There is a problem", "Il y a un problème"),
      workedOut: t("Worked out from your answers", "Calculé à partir de vos réponses")
    }
  }
];

/** What the demo opens on. */
export const DEFAULT_EXAMPLE_ID = "callback";
