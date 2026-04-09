const messages = {
	en: {
		appTitle: 'OSM Route Editor',
		focusModeHelp:
			'Focus mode: click a segment to show its Start/End handles (click again to deselect).',
		loadVisibleArea: 'Load visible area',
		strictContinuity: 'Strict continuity',
		reloadBbox: 'Reload (bbox)',
		clear: 'Clear',
		selectionStatus: 'Selection status',
		lastError: 'Last error',
		routeSegments: 'Route segments',
		segmentCount: ({ count }) => `${count} segment${count === 1 ? '' : 's'}`,
		import: 'Import',
		export: 'Export',
		exportDrawable: 'Export drawable',
		loadWays: 'Load ways',
		formatJson: 'Format JSON',
		unapplied: 'Not applied',
		from: 'from',
		to: 'to',
		useCurrentColor: ({ color }) => `Use ${color} as current color`,
		json: 'JSON',
		jsonMeta: 'import/export',
		jsonDescription: 'Import/export, lint in the gutter',
		drawableJson: 'Drawable JSON',
		drawableJsonMeta: 'drawable export',
		drawableJsonDescription: 'Output with ready-to-render primitives',
		jsonEmpty: 'JSON field is empty.',
		jsonInvalidSyntax: 'Invalid JSON syntax.',
		jsonFormatExpected: 'Expected format: {"route":[...], "annotations":[...]} or [...]',
		jsonInvalidColor: ({ index }) =>
			`Segment #${index}: invalid color (expected: #RRGGBB)`,
		jsonInvalidWayId: ({ index }) => `Segment #${index}: invalid wayId`,
		jsonInvalidFromNode: ({ index }) => `Segment #${index}: invalid fromNode`,
		jsonInvalidToNode: ({ index }) => `Segment #${index}: invalid toNode`,
		jsonEqualNodes: ({ index }) => `Segment #${index}: fromNode == toNode`,
		jsonAnnotationInvalidText: ({ index }) =>
			`Annotation #${index}: invalid text`,
		jsonAnnotationInvalidLatLon: ({ index }) =>
			`Annotation #${index}: invalid lat/lon`,
		jsonAnnotationInvalidColor: ({ index }) =>
			`Annotation #${index}: invalid color (expected: #RRGGBB)`,
		jsonAnnotationInvalidFontSize: ({ index }) =>
			`Annotation #${index}: invalid fontSize (10-32)`,
		jsonNoValidContent: 'No valid segment or annotation found.',
		codeMirrorMissing:
			"CodeMirror is not available.\nCheck that the CodeMirror scripts are loaded BEFORE app.js in index.html.\nExample: <script src='.../codemirror.min.js'></script> then <script type='module' src='app.js'></script>",
		selectionTool: 'Selection tool',
		flipTool: 'Flip direction tool',
		creationTool: 'Creation tool',
		textAnnotationTool: 'Text annotation tool',
		debugWaysTool: 'Debug: draw loaded ways in viewport',
		drawingColor: 'Drawing color',
		color: 'Color',
		annotation: 'Annotation',
		annotationPlacementHint:
			'Switch to annotation mode and click the map to place a note, then double-click it to edit the text.',
		annotationSelectedHint:
			'Selected note: use the map bubble to edit text, or change style here.',
		annotationEditingHint:
			'Editing note: type in the map bubble, then save or cancel.',
		annotationFontSize: 'Annotation font size',
		new: 'New',
		delete: 'Delete',
		save: 'Save',
		cancel: 'Cancel',
		editAnnotationText: 'Edit annotation text',
		satellite: 'Satellite',
		map: 'Map',
		switchToView: ({ view }) => `Switch to ${view} view`,
		initialPickStatus: 'No point',
		statusSynchronized: 'Synchronized',
		statusExportReady: 'Drawable export ready',
		statusModifiedValid: 'Modified (valid)',
		statusInvalid: 'Invalid',
		modeSelect:
			'Selection mode: click an existing segment on the map or in the list.',
		modeAnnotate: 'Annotation mode: click on the map to place a note.',
		modeFlip:
			'Flip mode: click an existing segment on the map to reverse its direction.',
		modeCreate: 'Creation mode: click on the map to add a segment.',
		segmentFlipped: ({ index }) => `Segment ${index} direction flipped.`,
		annotationModeHint:
			'Annotation mode: double-click the note to edit text, or drag it to move it.',
		annotationEditHint:
			'Editing annotation: update the text in the map bubble, then click Save or Cancel.',
		annotationAdded:
			'Annotation added: double-click the note to edit its text.',
		drawableExportIncomplete: ({ items }) =>
			`Incomplete drawable export: missing geometry for ${items}`,
		viewerMissingTag:
			"Missing <script id='route-json' type='application/json'> tag.",
		viewerEmptyTag: 'route-json is empty.',
		viewerInvalidJson: 'Invalid JSON in route-json.',
		viewerFormatExpected:
			'Expected format: {"route":[...]} or {"route":[...], "primitives":[...]}',
		viewerOkAutonomous: 'OK (self-contained)',
		viewerLoadingWays: 'Loading ways…',
		viewerOk: 'OK',
	},
	fr: {
		appTitle: 'OSM Route Editor',
		focusModeHelp:
			'Focus mode : clique un segment pour afficher ses handles Start/End (clique à nouveau pour désélectionner).',
		loadVisibleArea: 'Charger la zone visible',
		strictContinuity: 'Continuité stricte',
		reloadBbox: 'Recharger (bbox)',
		clear: 'Vider',
		selectionStatus: 'Statut sélection',
		lastError: 'Dernière erreur',
		routeSegments: 'Itinéraire (tronçons)',
		segmentCount: ({ count }) => `${count} segment${count > 1 ? 's' : ''}`,
		import: 'Importer',
		export: 'Exporter',
		exportDrawable: 'Exporter dessin',
		loadWays: 'Charger les ways',
		formatJson: 'Formater JSON',
		unapplied: 'Non appliqué',
		from: 'from',
		to: 'to',
		useCurrentColor: ({ color }) => `Utiliser ${color} comme couleur courante`,
		json: 'JSON',
		jsonMeta: 'import/export',
		jsonDescription: 'Import/export, lint dans la marge',
		drawableJson: 'JSON dessin',
		drawableJsonMeta: 'export drawable',
		drawableJsonDescription: 'Sortie en primitives prêtes à dessiner',
		jsonEmpty: 'Champ JSON vide.',
		jsonInvalidSyntax: 'JSON invalide (syntaxe).',
		jsonFormatExpected:
			'Format attendu: {"route":[...], "annotations":[...]} ou [...]',
		jsonInvalidColor: ({ index }) =>
			`Segment #${index}: color invalide (attendu: #RRGGBB)`,
		jsonInvalidWayId: ({ index }) => `Segment #${index}: wayId invalide`,
		jsonInvalidFromNode: ({ index }) => `Segment #${index}: fromNode invalide`,
		jsonInvalidToNode: ({ index }) => `Segment #${index}: toNode invalide`,
		jsonEqualNodes: ({ index }) => `Segment #${index}: fromNode == toNode`,
		jsonAnnotationInvalidText: ({ index }) =>
			`Annotation #${index}: text invalide`,
		jsonAnnotationInvalidLatLon: ({ index }) =>
			`Annotation #${index}: lat/lon invalides`,
		jsonAnnotationInvalidColor: ({ index }) =>
			`Annotation #${index}: color invalide (attendu: #RRGGBB)`,
		jsonAnnotationInvalidFontSize: ({ index }) =>
			`Annotation #${index}: fontSize invalide (10-32)`,
		jsonNoValidContent: 'Aucun segment ni annotation valide trouvé.',
		codeMirrorMissing:
			"CodeMirror n'est pas disponible.\nVérifie que les scripts CodeMirror sont bien chargés AVANT app.js dans index.html.\nEx: <script src='.../codemirror.min.js'></script> puis <script type='module' src='app.js'></script>",
		selectionTool: 'Outil de sélection',
		flipTool: "Outil d'inversion de sens",
		creationTool: 'Outil de création',
		textAnnotationTool: "Outil d'annotation texte",
		debugWaysTool: 'Debug : dessiner les ways chargées dans le viewport',
		drawingColor: 'Couleur de dessin',
		color: 'Couleur',
		annotation: 'Annotation',
		annotationPlacementHint:
			'Passe en mode annotation puis clique sur la carte pour poser une note, puis double-clique dessus pour éditer le texte.',
		annotationSelectedHint:
			'Sélection courante : édite le texte sur la carte ou change le style ici.',
		annotationEditingHint:
			'Édition en cours : saisis le texte dans la bulle sur la carte, puis valide ou annule.',
		annotationFontSize: "Taille de police de l'annotation",
		new: 'Nouveau',
		delete: 'Supprimer',
		save: 'Enregistrer',
		cancel: 'Annuler',
		editAnnotationText: "Modifier le texte de l'annotation",
		satellite: 'Satellite',
		map: 'Carte',
		switchToView: ({ view }) => `Basculer vers la vue ${view}`,
		initialPickStatus: 'Aucun point',
		statusSynchronized: 'Synchronisé',
		statusExportReady: 'Export dessin prêt',
		statusModifiedValid: 'Modifié (valide)',
		statusInvalid: 'Invalide',
		modeSelect:
			'Mode sélection : clique un segment existant sur la carte ou dans la liste.',
		modeAnnotate: 'Mode annotation : clique sur la carte pour poser une note.',
		modeFlip:
			"Mode inversion : clique un segment existant sur la carte pour inverser son sens.",
		modeCreate: 'Mode création : clique sur la carte pour ajouter un tronçon.',
		segmentFlipped: ({ index }) => `Sens du segment ${index} inversé.`,
		annotationModeHint:
			'Mode annotation : double-clique la note pour éditer le texte, ou glisse-la pour la déplacer.',
		annotationEditHint:
			"Édition annotation : modifie le texte dans la bulle sur la carte, puis clique sur Enregistrer ou Annuler.",
		annotationAdded:
			'Annotation ajoutée : double-clique la note pour modifier son texte.',
		drawableExportIncomplete: ({ items }) =>
			`Export dessin incomplet: géométrie introuvable pour ${items}`,
		viewerMissingTag:
			"Balise <script id='route-json' type='application/json'> introuvable.",
		viewerEmptyTag: 'route-json est vide.',
		viewerInvalidJson: 'JSON invalide dans route-json.',
		viewerFormatExpected:
			'Format attendu: {"route":[...]} ou {"route":[...], "primitives":[...]}',
		viewerOkAutonomous: 'OK (autonome)',
		viewerLoadingWays: 'Chargement des ways…',
		viewerOk: 'OK',
	},
}

function normalizeLocale(locale) {
	const raw = typeof locale === 'string' ? locale.trim().toLowerCase() : ''
	if (!raw) return 'en'
	const short = raw.split('-')[0]
	return messages[short] ? short : 'en'
}

export function getLocale() {
	try {
		const stored =
			typeof window !== 'undefined'
				? window.localStorage.getItem('routecraft.locale')
				: null
		if (stored) return normalizeLocale(stored)
	} catch {}

	if (typeof document !== 'undefined' && document.documentElement?.lang) {
		const docLocale = normalizeLocale(document.documentElement.lang)
		if (docLocale) return docLocale
	}

	if (typeof navigator !== 'undefined') {
		return normalizeLocale(navigator.language || navigator.languages?.[0])
	}

	return 'en'
}

export function setLocale(locale, { persist = true } = {}) {
	const next = normalizeLocale(locale)
	if (typeof document !== 'undefined') {
		document.documentElement.lang = next
	}
	if (persist && typeof window !== 'undefined') {
		try {
			window.localStorage.setItem('routecraft.locale', next)
		} catch {}
	}
	return next
}

export function t(key, vars = {}) {
	const locale = getLocale()
	const dict = messages[locale] || messages.en
	const fallback = messages.en
	const value = dict[key] ?? fallback[key] ?? key
	return typeof value === 'function' ? value(vars) : value
}

if (typeof window !== 'undefined') {
	window.RouteCraftI18n = {
		getLocale,
		setLocale,
		availableLocales: Object.keys(messages),
	}
}
