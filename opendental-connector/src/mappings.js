// Map Pydental's friendly ids to Open Dental ids. Edit these for your clinic
// using your real provider numbers, operatory numbers and CDT procedure codes.

export const DOCTORS = [
  // serviceId values must match the SERVICES keys below.
  { id: "12", name: "Dr Leila Hariri", providerNum: 12, operatoryNum: 1, services: ["cleaning", "invisalign-consultation", "checkup"] },
  { id: "15", name: "Dr Omar Said", providerNum: 15, operatoryNum: 2, services: ["cleaning", "whitening", "checkup"] },
];

export const SERVICES = {
  "cleaning": { name: "Cleaning", durationMin: 30, procedureCode: "D1110" },
  "checkup": { name: "Check-up", durationMin: 20, procedureCode: "D0120" },
  "whitening": { name: "Whitening", durationMin: 60, procedureCode: "D9972" },
  "invisalign-consultation": { name: "Invisalign consultation", durationMin: 45, procedureCode: "D8090" },
};
