import { describe, it, expect } from 'vitest';

/**
 * Tests for country location filtering logic
 * 
 * These functions are defined in search-subscriptions.ts but we test the logic here
 * to verify the CA (Canada) vs CA (California) disambiguation works correctly.
 */

/**
 * Ensure location string includes country name for LinkedIn compatibility.
 * LinkedIn doesn't support country_indeed, so we need the country in the location string.
 */
function ensureCountryInLocation(location: string, country: string): string {
  if (!country || !location) return location;
  const locationLower = location.toLowerCase();
  const countryLower = country.toLowerCase();
  
  // Check if country is already in the location string
  if (locationLower.includes(countryLower)) {
    return location;
  }
  
  // Append country to location
  return `${location}, ${country}`;
}

/**
 * Check if a job location is in a wrong country based on the target country.
 * This is a safety net to filter out jobs that slip through due to ambiguous location codes.
 */
function isWrongCountry(jobLocation: string | undefined, targetCountry: string): boolean {
  if (!jobLocation || !targetCountry) return false;
  
  const jobLocationLower = jobLocation.toLowerCase();
  const targetCountryLower = targetCountry.toLowerCase();
  
  // US indicators - looking for clear signs this is a US location
  const usIndicators = [
    ', us', ' us', ', usa', ' usa', 'united states',
    'california', 'new york', 'texas', 'florida', 'illinois',
    'pennsylvania', 'ohio', 'georgia', 'north carolina', 'michigan',
    'new jersey', 'virginia', 'arizona', 'massachusetts', 'washington',
    'colorado', 'tennessee', 'indiana', 'missouri', 'maryland',
  ];
  
  // Canadian indicators
  const canadaIndicators = [
    'canada', ', on,', ', on ', ', bc,', ', bc ', ', ab,', ', ab ', ', qc,', ', qc ',
    ', mb,', ', mb ', ', sk,', ', ns,', ', nb,', ', nl,', ', pe,',
    'ontario', 'british columbia', 'alberta', 'quebec', 'manitoba', 'saskatchewan',
    'nova scotia', 'new brunswick', 'newfoundland', 'toronto', 'vancouver', 'montreal',
    'calgary', 'ottawa', 'edmonton', 'winnipeg',
  ];
  
  if (targetCountryLower === 'canada') {
    const hasUsIndicator = usIndicators.some(ind => jobLocationLower.includes(ind));
    const hasCanadaIndicator = canadaIndicators.some(ind => jobLocationLower.includes(ind));
    
    if (hasUsIndicator && !hasCanadaIndicator) {
      return true;
    }
  } else if (targetCountryLower === 'usa' || targetCountryLower === 'united states') {
    const hasUsIndicator = usIndicators.some(ind => jobLocationLower.includes(ind));
    const hasCanadaIndicator = canadaIndicators.some(ind => jobLocationLower.includes(ind));
    
    if (hasCanadaIndicator && !hasUsIndicator) {
      return true;
    }
  }
  
  return false;
}

describe('ensureCountryInLocation', () => {
  describe('appends country when not present', () => {
    it('appends Canada to Toronto, ON', () => {
      expect(ensureCountryInLocation('Toronto, ON', 'Canada')).toBe('Toronto, ON, Canada');
    });

    it('appends Canada to Vancouver', () => {
      expect(ensureCountryInLocation('Vancouver', 'Canada')).toBe('Vancouver, Canada');
    });

    it('appends USA to San Francisco, CA', () => {
      expect(ensureCountryInLocation('San Francisco, CA', 'USA')).toBe('San Francisco, CA, USA');
    });
  });

  describe('does not append country when already present', () => {
    it('keeps Toronto, ON, Canada unchanged', () => {
      expect(ensureCountryInLocation('Toronto, ON, Canada', 'Canada')).toBe('Toronto, ON, Canada');
    });

    it('keeps Canada unchanged when country is Canada', () => {
      expect(ensureCountryInLocation('Canada', 'Canada')).toBe('Canada');
    });

    it('keeps San Francisco, CA, USA unchanged', () => {
      expect(ensureCountryInLocation('San Francisco, CA, USA', 'USA')).toBe('San Francisco, CA, USA');
    });
  });

  describe('handles edge cases', () => {
    it('returns empty location unchanged', () => {
      expect(ensureCountryInLocation('', 'Canada')).toBe('');
    });

    it('returns location unchanged when country is empty', () => {
      expect(ensureCountryInLocation('Toronto', '')).toBe('Toronto');
    });

    it('is case-insensitive for country detection', () => {
      expect(ensureCountryInLocation('Toronto, CANADA', 'Canada')).toBe('Toronto, CANADA');
      expect(ensureCountryInLocation('toronto, canada', 'CANADA')).toBe('toronto, canada');
    });
  });
});

describe('isWrongCountry', () => {
  describe('detects California jobs when targeting Canada', () => {
    it('rejects San Francisco, CA, US', () => {
      expect(isWrongCountry('San Francisco, CA, US', 'Canada')).toBe(true);
    });

    it('rejects Los Angeles, CA, US', () => {
      expect(isWrongCountry('Los Angeles, CA, US', 'Canada')).toBe(true);
    });

    it('rejects San Jose, California, USA', () => {
      expect(isWrongCountry('San Jose, California, USA', 'Canada')).toBe(true);
    });

    it('rejects Burbank, CA, United States', () => {
      expect(isWrongCountry('Burbank, CA, United States', 'Canada')).toBe(true);
    });
  });

  describe('accepts Canadian jobs when targeting Canada', () => {
    it('accepts Toronto, ON, CA', () => {
      expect(isWrongCountry('Toronto, ON, CA', 'Canada')).toBe(false);
    });

    it('accepts Vancouver, BC, Canada', () => {
      expect(isWrongCountry('Vancouver, BC, Canada', 'Canada')).toBe(false);
    });

    it('accepts Montreal, QC, Canada', () => {
      expect(isWrongCountry('Montreal, QC, Canada', 'Canada')).toBe(false);
    });

    it('accepts Calgary, AB, CA', () => {
      expect(isWrongCountry('Calgary, AB, CA', 'Canada')).toBe(false);
    });

    it('accepts Ontario, Canada', () => {
      expect(isWrongCountry('Ontario, Canada', 'Canada')).toBe(false);
    });

    it('accepts Toronto', () => {
      expect(isWrongCountry('Toronto', 'Canada')).toBe(false);
    });
  });

  describe('detects Canadian jobs when targeting USA', () => {
    it('rejects Toronto, ON, Canada', () => {
      expect(isWrongCountry('Toronto, ON, Canada', 'USA')).toBe(true);
    });

    it('rejects Vancouver, BC, Canada', () => {
      expect(isWrongCountry('Vancouver, BC, Canada', 'USA')).toBe(true);
    });

    it('rejects Montreal, QC, Canada', () => {
      expect(isWrongCountry('Montreal, QC, Canada', 'USA')).toBe(true);
    });
  });

  describe('accepts US jobs when targeting USA', () => {
    it('accepts San Francisco, CA, US', () => {
      expect(isWrongCountry('San Francisco, CA, US', 'USA')).toBe(false);
    });

    it('accepts New York, NY, USA', () => {
      expect(isWrongCountry('New York, NY, USA', 'USA')).toBe(false);
    });

    it('accepts Austin, TX, United States', () => {
      expect(isWrongCountry('Austin, TX, United States', 'USA')).toBe(false);
    });
  });

  describe('handles remote jobs and edge cases', () => {
    it('returns false for undefined location', () => {
      expect(isWrongCountry(undefined, 'Canada')).toBe(false);
    });

    it('returns false for empty location', () => {
      expect(isWrongCountry('', 'Canada')).toBe(false);
    });

    it('returns false for "Remote" location', () => {
      expect(isWrongCountry('Remote', 'Canada')).toBe(false);
    });

    it('returns false for empty target country', () => {
      expect(isWrongCountry('San Francisco, CA, US', '')).toBe(false);
    });

    it('returns false for non-US/Canada target country', () => {
      expect(isWrongCountry('San Francisco, CA, US', 'Germany')).toBe(false);
    });
  });

  describe('handles ambiguous locations correctly', () => {
    it('rejects ambiguous CA without Canada indicator', () => {
      // "CA" alone is ambiguous, but ", US" makes it clear it's California
      expect(isWrongCountry('Mountain View, CA, US', 'Canada')).toBe(true);
    });

    it('accepts ambiguous CA with Canada indicator', () => {
      // "ON, CA" is Canadian Ontario
      expect(isWrongCountry('Toronto, ON, CA', 'Canada')).toBe(false);
    });

    it('handles case-insensitive matching', () => {
      expect(isWrongCountry('SAN FRANCISCO, CA, US', 'Canada')).toBe(true);
      expect(isWrongCountry('toronto, on, canada', 'Canada')).toBe(false);
    });
  });

  describe('real-world examples from Kunj subscription', () => {
    // These are actual job locations that appeared in Kunj's results
    it('rejects Solution Engineer | AvePoint | Los Angeles, CA, US', () => {
      expect(isWrongCountry('Los Angeles, CA, US', 'Canada')).toBe(true);
    });

    it('rejects Staff Fraud and Risk Analyst | Intuit | San Diego, CA, US', () => {
      expect(isWrongCountry('San Diego, CA, US', 'Canada')).toBe(true);
    });

    it('rejects Network Systems Engineer Intern | General Dynamics | San Jose, CA, US', () => {
      expect(isWrongCountry('San Jose, CA, US', 'Canada')).toBe(true);
    });

    it('accepts Production Engineer | Company | Toronto, ON, CA', () => {
      expect(isWrongCountry('Toronto, ON, CA', 'Canada')).toBe(false);
    });

    it('accepts Support Engineer | Company | Vancouver, BC, CA', () => {
      expect(isWrongCountry('Vancouver, BC, CA', 'Canada')).toBe(false);
    });
  });
});
