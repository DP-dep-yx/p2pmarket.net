// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TrustMarketsRegistry
 * @notice Decentralized B2B Identity Registry on Base L2 (Trust Net v10.0)
 * @dev Separates wallet reputation from Web2 domain names. Supports safe domain re-binding
 *      and $1 anti-spam registration fee.
 */
contract TrustMarketsRegistry {
    struct BusinessProfile {
        string domain;          // "company.com"
        string businessInfo;    // Short business description
        string aiPromptUri;     // URI to prompt.json / JSON-LD Schema.org
        uint256 updatedAt;      // Timestamp of last update
        bool isActive;          // Profile status
    }

    mapping(address => BusinessProfile) public profiles;
    mapping(bytes32 => address) public domainToOwner;
    mapping(address => mapping(address => bool)) public mutualHandshakes;
    mapping(address => mapping(address => bool)) public handshakeProposals;

    address public immutable treasury;
    uint256 public registrationFeeWei; // Default ~$1 in ETH on Base (~0.00033 ETH)

    event ProfileUpdated(address indexed wallet, string domain, string aiPromptUri, uint256 timestamp);
    event DomainRebound(address indexed wallet, string oldDomain, string newDomain);
    event HandshakeProposed(address indexed proposer, address indexed counterparty, bytes32 proposerDomainHash);
    event MutualHandshakeEstablished(address indexed partyA, address indexed partyB, uint256 timestamp);
    event HandshakeRevoked(address indexed partyA, address indexed partyB);

    error InsufficientAntiSpamFee(uint256 sent, uint256 required);
    error DomainAlreadyClaimed(string domain, address currentOwner);
    error EmptyDomain();
    error ProfileNotActive();

    constructor(address _treasury, uint256 _registrationFeeWei) {
        treasury = _treasury == address(0) ? msg.sender : _treasury;
        registrationFeeWei = _registrationFeeWei;
    }

    /**
     * @notice Register or update a B2B profile. First-time registration requires the $1 anti-spam fee.
     * @dev Re-binding a new domain automatically releases the old domain while preserving wallet history.
     */
    function setProfile(
        string calldata domain,
        string calldata businessInfo,
        string calldata aiPromptUri
    ) external payable {
        if (bytes(domain).length == 0) revert EmptyDomain();

        bytes32 newDomainHash = keccak256(abi.encodePacked(domain));
        address existingOwner = domainToOwner[newDomainHash];
        if (existingOwner != address(0) && existingOwner != msg.sender) {
            revert DomainAlreadyClaimed(domain, existingOwner);
        }

        BusinessProfile storage profile = profiles[msg.sender];

        // First registration requires anti-spam fee
        if (profile.updatedAt == 0 && msg.value < registrationFeeWei) {
            revert InsufficientAntiSpamFee(msg.value, registrationFeeWei);
        }

        // Release old domain if wallet is migrating to a new domain
        if (bytes(profile.domain).length > 0) {
            bytes32 oldDomainHash = keccak256(abi.encodePacked(profile.domain));
            if (oldDomainHash != newDomainHash) {
                delete domainToOwner[oldDomainHash];
                emit DomainRebound(msg.sender, profile.domain, domain);
            }
        }

        profile.domain = domain;
        profile.businessInfo = businessInfo;
        profile.aiPromptUri = aiPromptUri;
        profile.updatedAt = block.timestamp;
        profile.isActive = true;

        domainToOwner[newDomainHash] = msg.sender;

        if (msg.value > 0) {
            (bool ok, ) = treasury.call{value: msg.value}("");
            require(ok, "Fee transfer failed");
        }

        emit ProfileUpdated(msg.sender, domain, aiPromptUri, block.timestamp);
    }

    /**
     * @notice Contract Type 2: Mutual Attestation Handshake / NDA
     * @dev Unlocks SIWE (EIP-4361) access to confidential prompts and encrypted price lists.
     */
    function proposeOrAcceptHandshake(address counterparty) external {
        if (!profiles[msg.sender].isActive) revert ProfileNotActive();
        require(counterparty != msg.sender && counterparty != address(0), "Invalid counterparty");

        handshakeProposals[msg.sender][counterparty] = true;
        bytes32 myDomainHash = keccak256(abi.encodePacked(profiles[msg.sender].domain));
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

    function hasActiveHandshake(address partyA, address partyB) external view returns (bool) {
        return mutualHandshakes[partyA][partyB];
    }

    function getOwnerByDomain(string calldata domain) external view returns (address) {
        return domainToOwner[keccak256(abi.encodePacked(domain))];
    }
}
