// Sources behind the steelhead trout conditions ranges (UCS-293), shown as links under
// "Where the ranges come from". Each link opens the paper at the cited page.
//
// Two page numbers can differ for one paper: the PDF page (what a PDF viewer counts from the first page,
// and what a `#page=` link opens) and the printed page (the number printed on the page itself). When they
// differ, the label shows both so a reader can find the passage either way.
//
// Page numbers below were checked against the downloaded PDFs on 2026-10-28, except the CalTrout & UC Davis
// 2017 report, which blocks direct downloads: its page comes from the Linear research document and has
// not been checked here.

export type SteelheadSourceKey = 'hanson2003' | 'stoecker2002' | 'caltrout2021Cesa' | 'caltrout2017' | 'scrParkway';

interface SteelheadSource {
  /** Short name shown in the link text. */
  label: string;
  url: string;
}

export const STEELHEAD_SOURCES: Readonly<Record<SteelheadSourceKey, SteelheadSource>> = {
  hanson2003: {
    label: 'Hanson 2003 (Santa Ynez River fishery habitat)',
    url: 'https://www.waterboards.ca.gov/waterrights/water_issues/programs/hearings/cachuma/phase2/exhibits/ccrbid1_224.pdf',
  },
  stoecker2002: {
    label: 'Stoecker 2002 (southern Santa Barbara County steelhead)',
    url: 'https://www.ecoatlas.org/upfiles/4271/final_steelhead_report_2002-06-21_compressed.pdf',
  },
  caltrout2021Cesa: {
    label: 'CalTrout 2021 (CESA listing petition)',
    url: 'https://nrm.dfg.ca.gov/FileHandler.ashx?DocumentID=193535',
  },
  caltrout2017: {
    label: 'CalTrout & UC Davis 2017 (species account)',
    url: 'https://caltrout.org/wp-content/uploads/2017/05/Southern-Steelhead-FINAL-1.pdf',
  },
  scrParkway: {
    label: 'Santa Clara River Parkway (species account)',
    url: 'https://parkway.scrwatershed.org/theriver/species/southern-steelhead/index.html',
  },
};

export interface SteelheadCitation {
  source: SteelheadSourceKey;
  /** Page counted from the first page of the PDF; the link opens here. */
  pdfPage?: number;
  /** Page number printed on the page, when it differs from the PDF page. */
  printedPage?: number;
  /** Section of a web page that has no pages, such as "Spawning". */
  section?: string;
  /** Text on a web page to highlight when the link opens (a browser text fragment). */
  textFragment?: string;
  /** Short caution shown after the link, such as that the page was not opened for checking. */
  caution?: string;
}

/** A line under "Where the ranges come from", with the papers that support it. */
export interface SteelheadBasisNote {
  text: string;
  citations?: readonly SteelheadCitation[];
}

/** Link address for a citation: opens a PDF at its page, or a web page at its highlighted text. */
export function steelheadCitationHref(citation: SteelheadCitation): string {
  const { url } = STEELHEAD_SOURCES[citation.source];
  if (citation.pdfPage !== undefined) return `${url}#page=${citation.pdfPage}`;
  if (citation.textFragment) return `${url}#:~:text=${encodeURIComponent(citation.textFragment)}`;
  return url;
}

/** Link text, such as "Hanson 2003 …, p. 2" or "Stoecker 2002 …, PDF p. 16 (printed p. 4)". */
export function steelheadCitationLabel(citation: SteelheadCitation): string {
  const { label } = STEELHEAD_SOURCES[citation.source];
  const { pdfPage, printedPage, section } = citation;
  let where = '';
  if (pdfPage !== undefined && printedPage !== undefined && printedPage !== pdfPage) {
    where = `PDF p. ${pdfPage} (printed p. ${printedPage})`;
  } else if (pdfPage !== undefined) {
    where = `p. ${pdfPage}`;
  } else if (section) {
    where = `section "${section}"`;
  }
  return where ? `${label}, ${where}` : label;
}
