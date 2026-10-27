// Compléments manuels au catalogue généré (etablissements.js) : établissements absents ou mal
// nommés dans OpenStreetMap. Fichier édité à la main — il n'est pas écrasé par
// scripts/gen-etablissements.mjs. Coordonnées relevées sur OSM (Nominatim) à l'adresse indiquée.

export const EXTRA_ETABLISSEMENTS = [
  // Centre de dialyse AURAL de Hautepierre : bâtiment OSM "AURAL", sans fiche "hôpital/clinique".
  { name: "AURAL – Centre de dialyse", type: "clinic", city: "Strasbourg", dept: "67", street: "Avenue Molière", lat: 48.594595, lng: 7.70834, aliases: ["AURAL", "Dialyse Hautepierre", "Dialyse Strasbourg"] },
  // Site HUS de l'Elsau (15 rue Cranach) : OSM n'y connaît que le service de pédopsychiatrie.
  // Absente d'OSM ; adresse donnée par l'utilisateur, placée via la Base Adresse Nationale (même
  // adresse que la Clinique de l'Ill). Le nom "Clinique du Ried" déclenche le forfait grande
  // ville par exception Cnam (GRANDE_VILLE_EXTENSION_MATCHERS dans tarif.js).
  { name: "Clinique du Ried", type: "clinic", city: "Schiltigheim", dept: "67", street: "1 Rue du Château d'Angleterre", lat: 48.622279, lng: 7.771622, aliases: ["Ried"] },
  { name: "Hôpital de l'Elsau", type: "hospital", city: "Strasbourg", dept: "67", street: "15 Rue Cranach", lat: 48.564921, lng: 7.716946, aliases: ["Elsau", "HUS Elsau"] },
];

// Corrections d'établissements du catalogue généré, par nom OSM exact : nouveau nom affiché
// (`name`) et/ou alias supplémentaires (`aliases`).
export const EXTRA_OVERRIDES = {
  // Rhéna (2017) a regroupé les cliniques Adassa, Diaconesses et Sainte-Odile de Strasbourg :
  // les chauffeurs les cherchent encore sous leurs anciens noms.
  "Clinique Rhéna": { aliases: ["Diaconesses", "Adassa", "Clinique des Diaconesses", "Clinique Adassa"] },
  // Établissement de l'UGECAM Alsace à Illkirch (confirmé par l'utilisateur, 2026-10-27). Le nom
  // affiché doit contenir "UGECAM" : avec la commune "Illkirch", il déclenche le forfait grande
  // ville par exception Cnam (GRANDE_VILLE_EXTENSION_MATCHERS dans tarif.js).
  "Institut Universitaire de Réadaptation Clémenceau": { name: "UGECAM – IUR Clémenceau", aliases: ["UGECAM", "UGECAM Illkirch", "IURC", "Clemenceau Illkirch"] },
};
