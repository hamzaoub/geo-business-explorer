// Official Google Places API (New) Table A place types.
// https://developers.google.com/maps/documentation/places/web-service/place-types
export const IT_EMPLOYER_TARGETS = [
  { type:"corporate_office", label:"Corporate offices and headquarters" },
  { type:"business_center", label:"Business centres" },
  { type:"coworking_space", label:"Coworking and startup spaces" },
  { type:"consultant", label:"Consulting firms" },
  { type:"marketing_consultant", label:"Digital marketing agencies" },
  { type:"research_institute", label:"Research and technology institutes" },
  { type:"manufacturer", label:"Manufacturing companies" },
  { type:"supplier", label:"Suppliers and distributors" },
  { type:"bank", label:"Banks and finance" },
  { type:"insurance_agency", label:"Insurance companies" },
  { type:"telecommunications_service_provider", label:"Telecommunications providers" },
  { type:"university", label:"Universities" },
  { type:"educational_institution", label:"Educational institutions" },
  { type:"hospital", label:"Hospitals and health networks" },
  { type:"shipping_service", label:"Logistics and shipping" },
  { type:"real_estate_agency", label:"Real estate companies" },
] as const;

export const IT_EMPLOYER_TYPES: string[] = IT_EMPLOYER_TARGETS.map(target=>target.type);
