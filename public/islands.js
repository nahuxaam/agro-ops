// National island codes, written the way a boat note prints them (Kaashidhoo is H-01).
// Picking an island fills its code. Picking a code fills the island.

const ISLANDS = [
  { atoll: 'HA', prefix: 'Ha', name: 'Thuraakunu', code: 'A-01', label: 'Ha. Thuraakunu', aliases: ['Thurakunu'] },
  { atoll: 'HA', prefix: 'Ha', name: 'Uligamu', code: 'A-02', label: 'Ha. Uligamu', aliases: ['Uligan'] },
  { atoll: 'HA', prefix: 'Ha', name: 'Molhadhoo', code: 'A-05', label: 'Ha. Molhadhoo', aliases: ['Mulhadhoo'] },
  { atoll: 'HA', prefix: 'Ha', name: 'Hoarafushi', code: 'A-06', label: 'Ha. Hoarafushi', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Ihavandhoo', code: 'A-07', label: 'Ha. Ihavandhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Kelaa', code: 'A-08', label: 'Ha. Kelaa', aliases: ['Kela'] },
  { atoll: 'HA', prefix: 'Ha', name: 'Vashafaru', code: 'A-09', label: 'Ha. Vashafaru', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Dhidhdhoo', code: 'A-10', label: 'Ha. Dhidhdhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Filladhoo', code: 'A-11', label: 'Ha. Filladhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Maarandhoo', code: 'A-12', label: 'Ha. Maarandhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Thakandhoo', code: 'A-13', label: 'Ha. Thakandhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Utheemu', code: 'A-14', label: 'Ha. Utheemu', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Muraidhoo', code: 'A-15', label: 'Ha. Muraidhoo', aliases: [] },
  { atoll: 'HA', prefix: 'Ha', name: 'Baarah', code: 'A-16', label: 'Ha. Baarah', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Faridhoo', code: 'B-01', label: 'HDh. Faridhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Hanimaadhoo', code: 'B-03', label: 'HDh. Hanimaadhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Finey', code: 'B-04', label: 'HDh. Finey', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Naivaadhoo', code: 'B-05', label: 'HDh. Naivaadhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Hirimaradhoo', code: 'B-06', label: 'HDh. Hirimaradhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Nolhivaranfaru', code: 'B-07', label: 'HDh. Nolhivaranfaru', aliases: ['Nolhivaran Faru'] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Nellaidhoo', code: 'B-08', label: 'HDh. Nellaidhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Nolhivaramu', code: 'B-09', label: 'HDh. Nolhivaramu', aliases: ['Nolhivaran', 'Nolhivaram'] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Kuribi', code: 'B-10', label: 'HDh. Kuribi', aliases: ['Kurinbi'] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Kuburudhoo', code: 'B-11', label: 'HDh. Kuburudhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Kulhudhuffushi', code: 'B-12', label: 'HDh. Kulhudhuffushi', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Kumundhoo', code: 'B-13', label: 'HDh. Kumundhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Neykurendhoo', code: 'B-14', label: 'HDh. Neykurendhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Vaikaradhoo', code: 'B-15', label: 'HDh. Vaikaradhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Maavaidhoo', code: 'B-16', label: 'HDh. Maavaidhoo', aliases: [] },
  { atoll: 'HDh', prefix: 'HDh', name: 'Makunudhoo', code: 'B-17', label: 'HDh. Makunudhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Kanditheemu', code: 'C-01', label: 'Sh. Kanditheemu', aliases: ['Kaditheemu'] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Noomaraa', code: 'C-02', label: 'Sh. Noomaraa', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Goidhoo', code: 'C-03', label: 'Sh. Goidhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Feydhoo', code: 'C-04', label: 'Sh. Feydhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Feevah', code: 'C-05', label: 'Sh. Feevah', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Bilehffahi', code: 'C-06', label: 'Sh. Bilehffahi', aliases: ['Bileffahi'] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Foakaidhoo', code: 'C-07', label: 'Sh. Foakaidhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Narudhoo', code: 'C-08', label: 'Sh. Narudhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Maroshi', code: 'C-10', label: 'Sh. Maroshi', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Lhaimagu', code: 'C-11', label: 'Sh. Lhaimagu', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Komandoo', code: 'C-13', label: 'Sh. Komandoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Maaugoodhoo', code: 'C-14', label: 'Sh. Maaugoodhoo', aliases: ['Maaungoodhoo'] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Funadhoo', code: 'C-15', label: 'Sh. Funadhoo', aliases: [] },
  { atoll: 'Sh', prefix: 'Sh', name: 'Milandhoo', code: 'C-16', label: 'Sh. Milandhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Henbadhoo', code: 'D-02', label: 'N. Henbadhoo', aliases: ['Henbandhoo', 'Hebadhoo'] },
  { atoll: 'N', prefix: 'N', name: 'Kendhikulhudhoo', code: 'D-03', label: 'N. Kendhikulhudhoo', aliases: ['Kendhikolhudhoo'] },
  { atoll: 'N', prefix: 'N', name: 'Maalhendhoo', code: 'D-05', label: 'N. Maalhendhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Kudafari', code: 'D-06', label: 'N. Kudafari', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Landhoo', code: 'D-07', label: 'N. Landhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Maafaru', code: 'D-08', label: 'N. Maafaru', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Lhohi', code: 'D-09', label: 'N. Lhohi', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Miladhoo', code: 'D-10', label: 'N. Miladhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Magoodhoo', code: 'D-11', label: 'N. Magoodhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Manadhoo', code: 'D-12', label: 'N. Manadhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Holhudhoo', code: 'D-13', label: 'N. Holhudhoo', aliases: [] },
  { atoll: 'N', prefix: 'N', name: 'Fodhdhoo', code: 'D-14', label: 'N. Fodhdhoo', aliases: ['Foddhoo'] },
  { atoll: 'N', prefix: 'N', name: 'Velidhoo', code: 'D-15', label: 'N. Velidhoo', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Alifushi', code: 'E-01', label: 'R. Alifushi', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Vaadhoo', code: 'E-02', label: 'R. Vaadhoo', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Rasgetheemu', code: 'E-03', label: 'R. Rasgetheemu', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Angolhitheemu', code: 'E-04', label: 'R. Angolhitheemu', aliases: ['Agolhitheemu'] },
  { atoll: 'R', prefix: 'R', name: 'Ugoofaaru', code: 'E-07', label: 'R. Ugoofaaru', aliases: ['Ungoofaaru', 'Ungufaaru'] },
  { atoll: 'R', prefix: 'R', name: 'Dhuvaafaru', code: 'E-08', label: 'R. Dhuvaafaru', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Maakurathu', code: 'E-09', label: 'R. Maakurathu', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Rasmaadhoo', code: 'E-10', label: 'R. Rasmaadhoo', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Innamaadhoo', code: 'E-11', label: 'R. Innamaadhoo', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Maduvvari', code: 'E-12', label: 'R. Maduvvari', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Inguraidhoo', code: 'E-13', label: 'R. Inguraidhoo', aliases: ['Iguraidhoo'] },
  { atoll: 'R', prefix: 'R', name: 'Fainu', code: 'E-14', label: 'R. Fainu', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Meedhoo', code: 'E-16', label: 'R. Meedhoo', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Kinolhas', code: 'E-17', label: 'R. Kinolhas', aliases: [] },
  { atoll: 'R', prefix: 'R', name: 'Hulhudhuffaaru', code: 'E-18', label: 'R. Hulhudhuffaaru', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Kudarikilu', code: 'F-01', label: 'B. Kudarikilu', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Kamadhoo', code: 'F-02', label: 'B. Kamadhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Kendhoo', code: 'F-03', label: 'B. Kendhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Kihaadhoo', code: 'F-06', label: 'B. Kihaadhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Dhonfanu', code: 'F-07', label: 'B. Dhonfanu', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Dharavandhoo', code: 'F-08', label: 'B. Dharavandhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Maalhos', code: 'F-09', label: 'B. Maalhos', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Eydhafushi', code: 'F-10', label: 'B. Eydhafushi', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Thulhaadhoo', code: 'F-12', label: 'B. Thulhaadhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Hithaadhoo', code: 'F-13', label: 'B. Hithaadhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Fulhadhoo', code: 'F-14', label: 'B. Fulhadhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Fehendhoo', code: 'F-15', label: 'B. Fehendhoo', aliases: [] },
  { atoll: 'B', prefix: 'B', name: 'Goidhoo', code: 'F-16', label: 'B. Goidhoo', aliases: [] },
  { atoll: 'Lh', prefix: 'Lh', name: 'Hinnavaru', code: 'G-01', label: 'Lh. Hinnavaru', aliases: [] },
  { atoll: 'Lh', prefix: 'Lh', name: 'Naifaru', code: 'G-02', label: 'Lh. Naifaru', aliases: [] },
  { atoll: 'Lh', prefix: 'Lh', name: 'Kurendhoo', code: 'G-03', label: 'Lh. Kurendhoo', aliases: [] },
  { atoll: 'Lh', prefix: 'Lh', name: 'Olhuvelifushi', code: 'G-04', label: 'Lh. Olhuvelifushi', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Kaashidhoo', code: 'H-01', label: 'K. Kaashidhoo', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Gaafaru', code: 'H-02', label: 'K. Gaafaru', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Dhiffushi', code: 'H-03', label: 'K. Dhiffushi', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Thulusdhoo', code: 'H-04', label: 'K. Thulusdhoo', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Huraa', code: 'H-05', label: 'K. Huraa', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Himmafushi', code: 'H-06', label: 'K. Himmafushi', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Gulhi', code: 'H-11', label: 'K. Gulhi', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Maafushi', code: 'H-12', label: 'K. Maafushi', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Guraidhoo', code: 'H-13', label: 'K. Guraidhoo', aliases: [] },
  { atoll: 'K', prefix: 'K', name: 'Male', code: 'T-10', label: 'K. Male', aliases: ['Maale', 'Male'] },
  { atoll: 'AA', prefix: 'AA', name: 'Thoddoo', code: 'U-01', label: 'AA. Thoddoo', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Rasdhoo', code: 'U-02', label: 'AA. Rasdhoo', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Ukulhas', code: 'U-04', label: 'AA. Ukulhas', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Mathiveri', code: 'U-05', label: 'AA. Mathiveri', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Bodufolhudhoo', code: 'U-06', label: 'AA. Bodufolhudhoo', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Feridhoo', code: 'U-07', label: 'AA. Feridhoo', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Maalhos', code: 'U-08', label: 'AA. Maalhos', aliases: [] },
  { atoll: 'AA', prefix: 'AA', name: 'Himandhoo', code: 'U-09', label: 'AA. Himandhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Hangnaameedhoo', code: 'I-01', label: 'ADh. Hangnaameedhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Omadhoo', code: 'I-02', label: 'ADh. Omadhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Kunburudhoo', code: 'I-03', label: 'ADh. Kunburudhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Mahibadhoo', code: 'I-04', label: 'ADh. Mahibadhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Mandhoo', code: 'I-05', label: 'ADh. Mandhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Dhangethi', code: 'I-06', label: 'ADh. Dhangethi', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Dhigurah', code: 'I-07', label: 'ADh. Dhigurah', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Fenfushi', code: 'I-08', label: 'ADh. Fenfushi', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Dhidhdhoo', code: 'I-09', label: 'ADh. Dhidhdhoo', aliases: [] },
  { atoll: 'ADh', prefix: 'ADh', name: 'Maamigili', code: 'I-10', label: 'ADh. Maamigili', aliases: [] },
  { atoll: 'V', prefix: 'V', name: 'Fulidhoo', code: 'J-01', label: 'V. Fulidhoo', aliases: [] },
  { atoll: 'V', prefix: 'V', name: 'Thinadhoo', code: 'J-02', label: 'V. Thinadhoo', aliases: [] },
  { atoll: 'V', prefix: 'V', name: 'Felidhoo', code: 'J-03', label: 'V. Felidhoo', aliases: [] },
  { atoll: 'V', prefix: 'V', name: 'Keyodhoo', code: 'J-04', label: 'V. Keyodhoo', aliases: [] },
  { atoll: 'V', prefix: 'V', name: 'Rakeedhoo', code: 'J-05', label: 'V. Rakeedhoo', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Raimandhoo', code: 'K-01', label: 'M. Raimandhoo', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Veyvah', code: 'K-03', label: 'M. Veyvah', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Mulah', code: 'K-04', label: 'M. Mulah', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Muli', code: 'K-05', label: 'M. Muli', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Naalaafushi', code: 'K-06', label: 'M. Naalaafushi', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Kolhufushi', code: 'K-07', label: 'M. Kolhufushi', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Dhiggaru', code: 'K-08', label: 'M. Dhiggaru', aliases: [] },
  { atoll: 'M', prefix: 'M', name: 'Maduvvari', code: 'K-09', label: 'M. Maduvvari', aliases: [] },
  { atoll: 'F', prefix: 'F', name: 'Feeali', code: 'L-01', label: 'F. Feeali', aliases: [] },
  { atoll: 'F', prefix: 'F', name: 'Bileddhoo', code: 'L-03', label: 'F. Bileddhoo', aliases: [] },
  { atoll: 'F', prefix: 'F', name: 'Magoodhoo', code: 'L-04', label: 'F. Magoodhoo', aliases: [] },
  { atoll: 'F', prefix: 'F', name: 'Dharaboodhoo', code: 'L-05', label: 'F. Dharaboodhoo', aliases: ['Dharanboodhoo'] },
  { atoll: 'F', prefix: 'F', name: 'Nilandhoo', code: 'L-06', label: 'F. Nilandhoo', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Meedhoo', code: 'M-01', label: 'Dh. Meedhoo', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Bandidhoo', code: 'M-02', label: 'Dh. Bandidhoo', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Rinbudhoo', code: 'M-03', label: 'Dh. Rinbudhoo', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Hulhudheli', code: 'M-04', label: 'Dh. Hulhudheli', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Maaenboodhoo', code: 'M-07', label: 'Dh. Maaenboodhoo', aliases: [] },
  { atoll: 'Dh', prefix: 'Dh', name: 'Kudahuvadhoo', code: 'M-08', label: 'Dh. Kudahuvadhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Buruni', code: 'N-01', label: 'Th. Buruni', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Vilufushi', code: 'N-02', label: 'Th. Vilufushi', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Madifushi', code: 'N-03', label: 'Th. Madifushi', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Dhiyamigili', code: 'N-04', label: 'Th. Dhiyamigili', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Guraidhoo', code: 'N-05', label: 'Th. Guraidhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Kandoodhoo', code: 'N-06', label: 'Th. Kandoodhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Vandhoo', code: 'N-07', label: 'Th. Vandhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Hirilandhoo', code: 'N-08', label: 'Th. Hirilandhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Gaadhiffushi', code: 'N-09', label: 'Th. Gaadhiffushi', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Thimarafushi', code: 'N-10', label: 'Th. Thimarafushi', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Veymandoo', code: 'N-11', label: 'Th. Veymandoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Kinbidhoo', code: 'N-12', label: 'Th. Kinbidhoo', aliases: [] },
  { atoll: 'Th', prefix: 'Th', name: 'Omadhoo', code: 'N-13', label: 'Th. Omadhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Isdhoo', code: 'O-01', label: 'L. Isdhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Dhanbidhoo', code: 'O-02', label: 'L. Dhanbidhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Maabaidhoo', code: 'O-03', label: 'L. Maabaidhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Mundoo', code: 'O-04', label: 'L. Mundoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Gan', code: 'O-06', label: 'L. Gan', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Maavah', code: 'O-07', label: 'L. Maavah', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Fonadhoo', code: 'O-08', label: 'L. Fonadhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Maamendhoo', code: 'O-10', label: 'L. Maamendhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Hithadhoo', code: 'O-11', label: 'L. Hithadhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Kunahandhoo', code: 'O-12', label: 'L. Kunahandhoo', aliases: [] },
  { atoll: 'L', prefix: 'L', name: 'Kalaidhoo', code: 'O-13', label: 'L. Kalaidhoo', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Kolamaafushi', code: 'P-01', label: 'Ga. Kolamaafushi', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Villingili', code: 'P-02', label: 'Ga. Villingili', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Maamendhoo', code: 'P-03', label: 'Ga. Maamendhoo', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Nilandhoo', code: 'P-04', label: 'Ga. Nilandhoo', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Dhaandhoo', code: 'P-05', label: 'Ga. Dhaandhoo', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Dhevvadhoo', code: 'P-06', label: 'Ga. Dhevvadhoo', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Kondey', code: 'P-07', label: 'Ga. Kondey', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Gemanafushi', code: 'P-09', label: 'Ga. Gemanafushi', aliases: [] },
  { atoll: 'GA', prefix: 'Ga', name: 'Kanduhulhudhoo', code: 'P-10', label: 'Ga. Kanduhulhudhoo', aliases: [] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Madaveli', code: 'Q-01', label: 'GDh. Madaveli', aliases: [] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Hoadedhdhoo', code: 'Q-02', label: 'GDh. Hoadedhdhoo', aliases: ['Hoandeddhoo'] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Nadellaa', code: 'Q-03', label: 'GDh. Nadellaa', aliases: [] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Gadhdhoo', code: 'Q-04', label: 'GDh. Gadhdhoo', aliases: ['Gaddhoo'] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Rathafandhoo', code: 'Q-05', label: 'GDh. Rathafandhoo', aliases: [] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Vaadhoo', code: 'Q-06', label: 'GDh. Vaadhoo', aliases: [] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Fiyoari', code: 'Q-07', label: 'GDh. Fiyoari', aliases: ['Fiyoaree'] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Faresmaathoda', code: 'Q-08', label: 'GDh. Faresmaathoda', aliases: ['Faresmaathodaa'] },
  { atoll: 'GDh', prefix: 'GDh', name: 'Thinadhoo', code: 'Q-10', label: 'GDh. Thinadhoo', aliases: [] },
  { atoll: 'Gn', prefix: 'Gn', name: 'Fuvahmulah', code: 'R-01', label: 'Gn. Fuvahmulah', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Meedhoo', code: 'S-01', label: 'S. Meedhoo', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Hithadhoo', code: 'S-02', label: 'S. Hithadhoo', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Maradhoo', code: 'S-03', label: 'S. Maradhoo', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Feydhoo', code: 'S-04', label: 'S. Feydhoo', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Maradhoofeydhoo', code: 'S-05', label: 'S. Maradhoofeydhoo', aliases: [] },
  { atoll: 'S', prefix: 'S', name: 'Hulhudhoo', code: 'S-06', label: 'S. Hulhudhoo', aliases: [] },
];

const CONFLICT = Symbol('island-name-conflict');
const byCode = new Map(ISLANDS.map(island => [island.code, island]));
const byExact = new Map();

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function addExact(key, island) {
  const n = norm(key);
  if (!n) return;
  const prev = byExact.get(n);
  if (prev === undefined) byExact.set(n, island);
  else if (prev !== island) byExact.set(n, CONFLICT);
}

for (const island of ISLANDS) {
  addExact(island.label, island);
  addExact(`${island.prefix} ${island.name}`, island);
  addExact(`${island.prefix}.${island.name}`, island);
  addExact(`${island.atoll} ${island.name}`, island);
  addExact(`${island.atoll}.${island.name}`, island);
  addExact(island.name, island);
  for (const alias of island.aliases) {
    addExact(alias, island);
    addExact(`${island.prefix} ${alias}`, island);
    addExact(`${island.prefix}.${alias}`, island);
    addExact(`${island.atoll}.${alias}`, island);
  }
}

// Male' is how destinations are written. The apostrophe is already stripped by norm.
addExact("Male'", byCode.get('T-10'));
addExact("K. Male'", byCode.get('T-10'));
addExact('Male', byCode.get('T-10'));

export function islandByCode(text, { partial = false } = {}) {
  const raw = String(text ?? '').trim();
  const m = /^([A-Za-z])\s*-?\s*(\d{1,2})$/.exec(raw);
  if (!m) return null;
  if (partial && m[2].length < 2) return null;
  const code = `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`;
  return byCode.get(code) || null;
}

export function islandByText(text) {
  const hit = byExact.get(norm(text));
  return hit && hit !== CONFLICT ? hit : null;
}

export function codeFor(text) {
  return islandByText(text)?.code || islandByCode(text)?.code || '';
}

// A typed code becomes the island name. A typed island name is left as written.
export function islandValue(text) {
  const asCode = islandByCode(text);
  if (asCode && !islandByText(text)) return asCode.label;
  return String(text ?? '').trim();
}

export function codeValue(islandText, codeText) {
  const named = islandByText(islandText);
  if (named) return named.code;
  const typedAsCode = islandByCode(islandText);
  if (typedAsCode) return typedAsCode.code;
  const code = String(codeText ?? '').trim();
  // An official code only stays with the island it belongs to.
  if (islandByCode(code)) return '';
  return code;
}

let listsReady = false;
function ensureIslandLists() {
  if (listsReady || typeof document === 'undefined') return;
  listsReady = true;
  const names = document.createElement('datalist');
  names.id = 'island-names';
  const codes = document.createElement('datalist');
  codes.id = 'island-codes';
  for (const island of ISLANDS) {
    const nameOpt = document.createElement('option');
    nameOpt.value = island.label;
    nameOpt.label = island.code;
    names.append(nameOpt);
    const codeOpt = document.createElement('option');
    codeOpt.value = island.code;
    codeOpt.label = island.label;
    codes.append(codeOpt);
  }
  document.body.append(names, codes);
}

// Either field can be omitted. A matching island fills the code, and a matching
// code fills the island. Text that is not in the list is left alone.
export function bindIslandPair(islandEl, codeEl) {
  if (!islandEl) return;
  ensureIslandLists();
  islandEl.setAttribute('list', 'island-names');
  islandEl.setAttribute('autocomplete', 'off');
  if (codeEl) {
    codeEl.setAttribute('list', 'island-codes');
    codeEl.setAttribute('autocomplete', 'off');
  }
  let lock = false;
  const applyIsland = finished => {
    if (lock) return;
    const typed = islandEl.value;
    if (!typed.trim()) {
      if (finished && codeEl && islandByCode(codeEl.value)) {
        lock = true;
        codeEl.value = '';
        lock = false;
      }
      return;
    }
    const asText = islandByText(typed);
    const asCode = islandByCode(typed, { partial: !finished });
    const hit = asText || asCode;
    if (!hit) {
      if (finished && codeEl && islandByCode(codeEl.value)) {
        lock = true;
        codeEl.value = '';
        lock = false;
      }
      return;
    }
    lock = true;
    if (!asText) islandEl.value = hit.label;
    if (codeEl && codeEl.value !== hit.code) codeEl.value = hit.code;
    lock = false;
  };
  const applyCode = finished => {
    if (lock || !codeEl) return;
    const typed = codeEl.value;
    if (!typed.trim()) return;
    const hit = islandByCode(typed, { partial: !finished }) || (finished ? islandByText(typed) : null);
    if (!hit) return;
    lock = true;
    if (codeEl.value !== hit.code) codeEl.value = hit.code;
    if (islandEl.value !== hit.label) islandEl.value = hit.label;
    lock = false;
  };
  islandEl.addEventListener('input', () => applyIsland(false));
  islandEl.addEventListener('change', () => applyIsland(true));
  if (codeEl) {
    codeEl.addEventListener('input', () => applyCode(false));
    codeEl.addEventListener('change', () => applyCode(true));
    if (!codeEl.value.trim()) applyIsland(false);
  }
}

