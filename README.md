# Météo Boue

Prévision de l'état des sols pour le VTT. Huit zones : Ariège, piémont
toulousain, Hautes-Pyrénées (corridor Lourdes — pic du Midi de Bigorre), Tarn,
Aude, Pyrénées-Orientales, Lot et Queyras.

Le Queyras est le seul massif hors Occitanie. À ~8 h de route de Toulouse, il
sort de tous les paliers de trajet et n'apparaît que sous « Tout » — c'est une
zone de séjour, pas de sortie du dimanche.

Aucun service météo ne garde l'historique récent, et aucun ne dit si ça va être
gras. Ce site croise **7 jours de météo passée et 7 jours à venir** avec la
**nature réelle du sol** de chaque spot, et en déduit un état jour par jour.

L'idée de fond : une même pluie ne produit pas le même sentier selon le sol.
40 mm sur les argiles du Lauragais, c'est une semaine de bourbier ; les mêmes
40 mm sur le karst de l'Arize, c'est sec en deux jours.

## Ce que ça donne

Une grille **spots × jours** : 75 lignes, 15 colonnes (7 jours passés,
aujourd'hui, 7 jours à venir). Une bande verte horizontale, c'est un spot
fiable ; une colonne verte, c'est un bon jour. Les prévisions sont hachurées
pour ne pas se confondre avec l'observé.

Au-dessus, la réponse en une phrase : « 54 spots sur 75 sont roulants samedi.
Le plus proche : Bouconne (~30 min, grip parfait). À éviter : Nailloux,
Pamiers. »

Les en-têtes de colonnes servent de **sélecteur de jour** : un clic sur samedi
recolore la carte, réordonne les spots et réécrit le verdict. Un clic sur une
cellule ouvre le détail du spot pour ce jour-là — frise des précipitations,
nature du sol, bilan hydrique, paramètres du modèle.

### La couleur ne code qu'une chose

La teinte porte uniquement la **roulabilité**, sur une rampe continue vert →
rouge : plus c'est vert, plus on y va. Il n'y a aucune légende à mémoriser.

La *cause* est portée séparément, par un pictogramme, et seulement quand elle
sort de l'ordinaire : ❄ pour le gel, la neige et le dégel. L'eau étant
l'explication par défaut, elle n'a pas de symbole.

C'est une correction d'une première version où la couleur mélangeait
l'humidité (une grandeur physique) et la roulabilité (une décision), ce qui
obligeait à retenir une légende de huit entrées pour lire une carte.

## Lancer

```bash
python -m http.server 8123
```

Puis ouvrir <http://localhost:8123/>. Aucune dépendance à installer, aucun
backend : le navigateur appelle Open-Meteo directement.

Les caractéristiques de sol sont figées dans `data/spots.enriched.json`. Après
avoir ajouté des spots dans `data/spots.json` :

```bash
node scripts/enrich-spots.mjs
```

Seuls les spots absents du fichier sont calculés ; ajouter une zone ne
rejoue pas les autres. `--force` recalcule tout.

Le script est volontairement lent (~12 s par spot) : SoilGrids plafonne autour
de 5 requêtes par minute.

## Les données

| Donnée | Source | Accès |
|---|---|---|
| Pluie, neige, ET0, températures | [Open-Meteo](https://open-meteo.com) | libre, sans clé, CORS ouvert |
| Humidité de sol simulée | Open-Meteo (modèle ICON) | idem, affichée comme signal de contrôle |
| Argile / limon / sable / densité | [SoilGrids](https://soilgrids.org) (ISRIC), 250 m | libre, ~5 req/min |
| Lithologie | [BRGM](http://geoservices.brgm.fr), carte au 1/1 000 000 | WMS `GetFeatureInfo`, libre |
| Altitude, pente, exposition | [IGN RGE ALTI](https://geoservices.ign.fr) via la Géoplateforme | libre, sans clé |
| Fond de carte | IGN Plan v2 (WMTS) | libre, sans clé |

Deux pièges rencontrés, notés ici pour mémoire :

- le WMS du BRGM refuse `INFO_FORMAT=application/json` sur cette couche ; il
  faut `text/plain` ou `application/vnd.ogc.gml` ;
- SoilGrids masque les pixels bâtis et les plans d'eau : il répond `200` avec
  `mean: null`. Le script rattrape le cas en échantillonnant une couronne
  autour du point.

## Le modèle

Un réservoir de 15 cm de sol, calé sur le spot, déroulé jour par jour
(`src/js/mud-model.js`) :

```
stock += pluie + fonte nivale − ruissellement
stock −= drainage(excès au-dessus de la capacité au champ)
stock −= évapotranspiration réelle
```

Les paramètres du réservoir viennent du sol local (`src/js/soil.js`) :

- **capacité au champ, point de flétrissement, porosité** par les fonctions de
  pédotransfert de Saxton & Rawls appliquées à la granulométrie SoilGrids ;
- **vitesse de drainage** pilotée par le taux d'argile, corrigée par la roche
  mère (le karst draine ~1,5×, la marne ~0,6×) puis par la pente — un sentier
  raide se purge tout seul ;
- **évapotranspiration** modulée par l'exposition : un versant sud sèche
  nettement plus vite qu'un nord, et l'effet s'annule à plat.

L'état du jour se lit sur le rapport `stock / capacité au champ`. Sous 0,50 le
sol est sec et poussiéreux ; autour de 0,5-0,8 c'est le *hero dirt*, l'humidité
idéale ; au-delà de 1,0 ça devient gras, et au-delà de 1,22 c'est un bourbier.
Les cas de gel, de dégel et de neige sont traités à part — un sol gelé roule
très bien, un sol en dégel est le pire moment possible pour les sentiers.

Chaque état porte une `roulabilite` de 0 à 100, qui est ce que la couleur
affiche. C'est délibérément un autre axe que l'humidité : un sol gelé et un sol
sec sont tous les deux roulants, pour des raisons opposées.

Les 60 jours d'historique demandés à Open-Meteo au-delà de la fenêtre affichée
servent à amorcer le réservoir : sans eux, on ignorerait dans quel état le sol
démarre.

### Une correction sur l'intuition de départ

Contrairement à ce qu'on croit souvent, **l'argile est le pire sol pour la
boue, pas le meilleur**. Sa conductivité hydraulique est de l'ordre de
10⁻⁸ m/s : l'eau ne s'infiltre pas, elle stagne, et le sol devient plastique et
collant. Ce qui draine vraiment, c'est le sable, l'arène granitique et surtout
le calcaire karstique.

Vérification du modèle sur 40 mm tombés sur un sol à la capacité au champ :

| Sol | Durée de boue |
|---|---|
| Argile de plaine | 7 jours |
| Limon sur granite | 3 jours |
| Calcaire karstique | 2 jours |

Et sur l'hiver réel 2025-2026 dans le Lauragais (151 jours) : la plaine
argileuse ressort impraticable 76 jours, le limon sur granite 31, le karst 12.

## Limites connues

- La lithologie BRGM utilisée est au 1/1 000 000 : elle donne la tendance d'un
  massif, pas la géologie d'un sentier. La carte au 1/50 000 existe et serait
  bien meilleure, mais elle n'est pas interrogeable en WMS — il faudrait
  charger le vecteur harmonisé depuis InfoTerre.
- Un spot est un point unique. Un massif présente en réalité des versants nord
  et sud qui n'ont rien à voir.
- Le couvert forestier n'est pas pris en compte : un sous-bois nord garde
  l'humidité bien plus longtemps que ce que le modèle annonce.
- Aucun calage terrain pour l'instant. Les seuils sont physiquement plausibles
  mais personne n'a encore confronté l'indice à la réalité d'une sortie.

## Suite

Le vrai levier, c'est le retour terrain : un bouton « j'y étais, c'était
comment ? » permettrait de recaler les coefficients massif par massif. Aucun
modèle physique ne battra dix vététistes qui remontent l'état réel. Cela
suppose une base de données — jusque-là, le site tient en fichiers statiques.
