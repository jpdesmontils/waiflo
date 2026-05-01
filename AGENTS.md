# Règles de travail

## Avant de coder

- Analyse la demande en détail avant toute action.
- Identifie tous les points ambigus et pose tes questions **avant** de commencer.
- Ne fais jamais d'hypothèse silencieuse : si tu n'es pas certain, demande.
- Valide ta compréhension du besoin en une phrase avant de proposer une solution.

## Qualité du code

- Signale tout code dupliqué détecté, même hors du périmètre de la demande.
- Signale tout code mort (fonctions, variables, imports inutilisés).
- Ne crée pas de nouvelle duplication en résolvant un problème.

## Correction de bugs

- Identifie et explique la **cause racine** du problème avant de proposer un correctif.
- Ne modifie jamais du code "pour voir" ou par élimination sans avoir une hypothèse claire.
- Sois certain à 100% que la correction adresse la cause identifiée avant de l'appliquer.
- Si plusieurs causes sont possibles, liste-les et argumente avant d'agir.

## Tests

- Ne modifie **jamais** un test pour le faire passer afin de résoudre un problème.
- Un test qui échoue est un signal : analyse-le, ne le contourne pas.
- Si un test semble incorrect, signale-le explicitement et attends validation avant toute modification.
