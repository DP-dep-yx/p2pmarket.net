// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal Chainlink Data Feed interface (latestRoundData only).
 * @dev ETH/USD on Base mainnet: 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 (answer = USD per 1 ETH, 8 dp).
 */
interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title TrustMarketsRegistry
 * @notice Decentralized B2B Identity Registry on Base L2 (Trust Net v17.1)
 * @dev Multi-domain identity: one wallet owns N domains, profile data is keyed by domain hash.
 *      $1 anti-spam fee (Skin in the Game) on every setProfile() AND on emergency deactivateProfile().
 *      v17.1: the $1 fee is computed live from the Chainlink ETH/USD Data Feed (registrationFeeWei()),
 *      so the tariff stays an honest dollar regardless of the ETH price. A stale feed reverts
 *      registration instead of charging a wrong amount.
 *      Domains are normalized to lowercase and validated against protocol/path characters.
 *      All collected fees are forwarded to the immutable treasury (platform fee recipient).
 *      Mutual attestation handshakes (Contract Type 2 / NDA) preserved from v10 and
 *      adapted to the multi-domain profile layout.
 */
contract TrustMarketsRegistry {
    struct BusinessProfile {
        string domain;          // lowercase "company.com"
        string businessInfo;    // Short business description
        string aiPromptUri;     // URI to prompt.json / JSON-LD Schema.org
        uint256 updatedAt;      // Timestamp of last update
        bool isActive;          // Profile status (false after deactivateProfile)
    }

    uint256 public constant MAX_PRICE_AGE = 24 hours; // staleness guard for the oracle

    mapping(bytes32 => address) public domainToOwner;
    mapping(bytes32 => BusinessProfile) public domainProfiles;
    mapping(address => bytes32[]) public ownerDomains;

    // Mutual attestation (Contract Type 2: NDA / trusted partner)
    mapping(address => mapping(address => bool)) public mutualHandshakes;
    mapping(address => mapping(address => bool)) public handshakeProposals;

    address public immutable treasury;
    AggregatorV3Interface public immutable ethUsdFeed; // Chainlink ETH/USD (8 dp), network-specific

    event ProfileUpdated(address indexed owner, string domain, string aiPromptUri);
    event ProfileDeactivated(address indexed owner, string domain);
    event HandshakeProposed(address indexed proposer, address indexed counterparty, bytes32 proposerDomainHash);
    event MutualHandshakeEstablished(address indexed partyA, address indexed partyB, uint256 timestamp);
    event HandshakeRevoked(address indexed partyA, address indexed partyB);

    error EmptyDomain();

    constructor(address _treasury, address _ethUsdFeed) {
        require(_ethUsdFeed != address(0), "Oracle feed required");
        treasury = _treasury == address(0) ? msg.sender : _treasury;
        ethUsdFeed = AggregatorV3Interface(_ethUsdFeed);
    }

    /**
     * @notice Honest anti-spam fee: $1 in wei at the live Chainlink ETH/USD rate.
     * @dev price = USD per 1 ETH with 8 decimals, so $1 = 1e26 / price wei
     *      (e.g. price = 168919000000 → fee = 592001190198880 wei ≈ 0.000592 ETH).
     *      A stale or broken feed reverts the call instead of charging a wrong amount:
     *      registrations simply pause until Chainlink resumes.
     */
    function registrationFeeWei() public view returns (uint256) {
        (, int256 price,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        require(price > 0, "Bad oracle price");
        require(updatedAt + MAX_PRICE_AGE >= block.timestamp, "Oracle price stale");
        return 1e26 / uint256(price);
    }

    /**
     * @dev Normalize ASCII domain to lowercase so "Company.com" and "company.com"
     *      hash to the same registry entry.
     */
    function _toLower(string memory str) internal pure returns (string memory) {
        bytes memory bStr = bytes(str);
        bytes memory bLower = new bytes(bStr.length);
        for (uint256 i = 0; i < bStr.length; i++) {
            if ((bStr[i] >= 0x41) && (bStr[i] <= 0x5A)) {
                bLower[i] = bytes1(uint8(bStr[i]) + 32);
            } else {
                bLower[i] = bStr[i];
            }
        }
        return string(bLower);
    }

    /**
     * @dev Reject protocol prefixes ("://") and path slashes — the registry stores
     *      bare hostnames only.
     */
    function _validateCleanDomain(string memory domain) internal pure {
        bytes memory b = bytes(domain);
        if (b.length == 0) revert EmptyDomain();
        for (uint256 i = 0; i < b.length; i++) {
            require(b[i] != ":", "Domain must not contain protocol (http/https)");
            require(b[i] != "/", "Domain must not contain path slashes");
        }
    }

    /**
     * @dev Forward the anti-spam fee to the platform treasury (wallet B).
     */
    function _forwardFee() internal {
        if (msg.value > 0) {
            (bool ok, ) = treasury.call{value: msg.value}("");
            require(ok, "Fee transfer failed");
        }
    }

    /**
     * @notice Register or update a profile for a domain ($1 Flat Fee, 1 Wallet = N Domains).
     * @dev Each domain gets its own profile record; a wallet can own many domains at once.
     *      The fee is charged on every registration AND every update (anti-spam Skin in the Game).
     */
    function setProfile(
        string calldata _rawDomain,
        string calldata _businessInfo,
        string calldata _aiPromptUri
    ) external payable {
        require(msg.value >= registrationFeeWei(), "Fee required ($1 in Base ETH)");

        string memory cleanDomain = _toLower(_rawDomain);
        _validateCleanDomain(cleanDomain);
        bytes32 newDomainHash = keccak256(abi.encodePacked(cleanDomain));

        address currentOwner = domainToOwner[newDomainHash];
        require(
            currentOwner == address(0) || currentOwner == msg.sender,
            "Domain owned by another wallet"
        );

        if (currentOwner == address(0)) {
            ownerDomains[msg.sender].push(newDomainHash);
        }

        domainToOwner[newDomainHash] = msg.sender;
        domainProfiles[newDomainHash] = BusinessProfile({
            domain: cleanDomain,
            businessInfo: _businessInfo,
            aiPromptUri: _aiPromptUri,
            updatedAt: block.timestamp,
            isActive: true
        });

        _forwardFee();
        emit ProfileUpdated(msg.sender, cleanDomain, _aiPromptUri);
    }

    /**
     * @notice Emergency deactivation and unbinding of a compromised domain ($1 Flat Fee).
     * @dev Use when DNS of the bound site is hijacked or the domain is lost. Frees the
     *      domain name in the registry and marks the profile inactive so third parties
     *      cannot present the stolen site as your verified profile. The wallet itself
     *      (and its on-chain Trust Score) is unaffected and can register a new domain.
     */
    function deactivateProfile(string calldata _domain) external payable {
        require(msg.value >= registrationFeeWei(), "Fee required ($1 in Base ETH)");

        string memory cleanDomain = _toLower(_domain);
        bytes32 domainHash = keccak256(abi.encodePacked(cleanDomain));

        require(domainToOwner[domainHash] == msg.sender, "Not domain owner");

        delete domainToOwner[domainHash];
        domainProfiles[domainHash].isActive = false;

        _forwardFee();
        emit ProfileDeactivated(msg.sender, cleanDomain);
    }

    /**
     * @notice Contract Type 2: Mutual Attestation Handshake / NDA
     * @dev Unlocks SIWE (EIP-4361) access to confidential prompts and encrypted price lists.
     *      Requires the caller to hold at least one active domain profile.
     */
    function proposeOrAcceptHandshake(address counterparty) external {
        bytes32 myDomainHash = _firstActiveDomainHash(msg.sender);
        require(myDomainHash != bytes32(0), "No active profile");
        require(counterparty != msg.sender && counterparty != address(0), "Invalid counterparty");

        handshakeProposals[msg.sender][counterparty] = true;
        emit HandshakeProposed(msg.sender, counterparty, myDomainHash);

        if (handshakeProposals[counterparty][msg.sender]) {
            mutualHandshakes[msg.sender][counterparty] = true;
            mutualHandshakes[counterparty][msg.sender] = true;
            emit MutualHandshakeEstablished(msg.sender, counterparty, block.timestamp);
        }
    }

    function revokeHandshake(address counterparty) external {
        handshakeProposals[msg.sender][counterparty] = false;
        mutualHandshakes[msg.sender][counterparty] = false;
        mutualHandshakes[counterparty][msg.sender] = false;
        emit HandshakeRevoked(msg.sender, counterparty);
    }

    /**
     * @dev First active domain hash owned by the wallet (multi-domain support for handshakes).
     */
    function _firstActiveDomainHash(address wallet) internal view returns (bytes32) {
        bytes32[] storage hashes = ownerDomains[wallet];
        for (uint256 i = 0; i < hashes.length; i++) {
            if (domainProfiles[hashes[i]].isActive) {
                return hashes[i];
            }
        }
        return bytes32(0);
    }

    function hasActiveHandshake(address partyA, address partyB) external view returns (bool) {
        return mutualHandshakes[partyA][partyB];
    }

    function getOwnerByDomain(string calldata domain) external view returns (address) {
        return domainToOwner[keccak256(abi.encodePacked(_toLower(domain)))];
    }

    /**
     * @dev Convenience view: full profile record for a bare hostname (auto-lowercased).
     */
    function getProfile(string calldata domain) external view returns (BusinessProfile memory) {
        return domainProfiles[keccak256(abi.encodePacked(_toLower(domain)))];
    }
}
